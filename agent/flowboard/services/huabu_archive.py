"""Portable ``.huabu`` workflow package export, import, and starter recipe instantiation.

A ``.huabu`` file is a standard ZIP archive containing:
  - ``manifest.json``: sanitized board metadata, nodes, edges, and media index
  - ``media/<media_id>.<ext>``: optional locally cached reference images/videos

Sensitive credentials, Flow project/account bindings, API keys, signed remote
URLs, chat histories, and execution logs are never exported.
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Board, Edge, Node
from flowboard.services import media as media_service
from flowboard.short_id import generate_unique_short_id

HUABU_FORMAT = "ai-canvas-studio.huabu"
HUABU_SCHEMA_VERSION = 1

MAX_ARCHIVE_BYTES = 150 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 250
MAX_MANIFEST_BYTES = 10 * 1024 * 1024
MAX_EXPORT_MEDIA_BYTES = 120 * 1024 * 1024
MAX_NODES_PER_BOARD = 300
MAX_EDGES_PER_BOARD = 1000

_COORD_MIN = -1_000_000.0
_COORD_MAX = 1_000_000.0
_SIZE_MAX = 100_000.0

ALLOWED_NODE_TYPES = {
    "character",
    "image",
    "video",
    "prompt",
    "note",
    "merge",
    "visual_asset",
    "Storyboard",
}

_SAFE_DATA_KEYS = {
    "title",
    "prompt",
    "aiBrief",
    "aspectRatio",
    "imageModel",
    "imageResolution",
    "thinkingLevel",
    "seed",
    "videoQuality",
    "videoResolution",
    "resolution",
    "omniVersion",
    "durationSeconds",
    "variantCount",
    "charCountry",
    "charVibe",
    "charGender",
    "storyboardGrid",
    "storyboardMode",
    "cameraPreset",
    "audioPrompt",
    "endMediaId",
    "mediaId",
    "mediaIds",
    "history",
    "renderedAt",
}

_EXT_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}


class HuabuArchiveError(ValueError):
    """Raised when a ``.huabu`` package is malformed, unsafe, or invalid."""


def _clamp(val: Any, lo: float, hi: float, default: float) -> float:
    try:
        num = float(val)
    except (TypeError, ValueError):
        return default
    if num < lo:
        return lo
    if num > hi:
        return hi
    return num


def _sniff_media_mime(data: bytes) -> Optional[str]:
    if len(data) < 12:
        return None
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[4:8] == b"ftyp":
        return "video/mp4"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    return None


def _sanitize_node_data(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, Any] = {}
    for k in _SAFE_DATA_KEYS:
        if k not in raw:
            continue
        v = raw[k]
        if v is None:
            continue
        if k == "mediaId":
            if isinstance(v, str) and media_service.is_valid_media_id(v):
                clean[k] = v
        elif k == "mediaIds":
            if isinstance(v, list):
                kept = [
                    m if isinstance(m, str) and media_service.is_valid_media_id(m) else None
                    for m in v[:16]
                ]
                if any(kept):
                    clean[k] = kept
        else:
            clean[k] = v
    return clean


def _safe_filename(board_name: str) -> str:
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", (board_name or "").strip()).strip(" .")
    if not stem:
        stem = "未命名工作流"
    return f"{stem[:80]}.huabu"


def instantiate_board_recipe(
    *,
    name: str,
    nodes_spec: list[dict[str, Any]],
    edges_spec: list[dict[str, Any]],
    target_board_id: Optional[int] = None,
    media_count: int = 0,
) -> dict[str, Any]:
    """Create (or populate an empty) Board with sanitized nodes & edges atomically."""
    if not isinstance(nodes_spec, list) or not isinstance(edges_spec, list):
        raise HuabuArchiveError("工作流配方格式无效：nodes 与 edges 必须为数组。")
    if len(nodes_spec) > MAX_NODES_PER_BOARD:
        raise HuabuArchiveError(f"单张画布最多支持导入 {MAX_NODES_PER_BOARD} 个节点。")
    if len(edges_spec) > MAX_EDGES_PER_BOARD:
        raise HuabuArchiveError(f"单张画布最多支持导入 {MAX_EDGES_PER_BOARD} 条连线。")

    clean_name = (name or "").strip()[:120] or "导入的工作流"

    with get_session() as s:
        board: Optional[Board] = None
        if target_board_id is not None:
            candidate = s.get(Board, target_board_id)
            if candidate is not None:
                existing_node = s.exec(
                    select(Node.id).where(Node.board_id == candidate.id)
                ).first()
                if existing_node is None:
                    candidate.name = clean_name
                    s.add(candidate)
                    s.flush()
                    board = candidate

        if board is None:
            board = Board(name=clean_name)
            s.add(board)
            s.flush()
            s.refresh(board)

        assert board.id is not None
        key_to_id: dict[str, int] = {}
        created_nodes: list[Node] = []

        for idx, spec in enumerate(nodes_spec):
            if not isinstance(spec, dict):
                raise HuabuArchiveError(f"第 {idx + 1} 个节点数据格式无效。")
            node_type = str(spec.get("type") or "").strip()
            if node_type not in ALLOWED_NODE_TYPES:
                raise HuabuArchiveError(f"包含不支持的节点类型：{node_type!r}")

            node_key = str(spec.get("key") if spec.get("key") is not None else idx)
            if node_key in key_to_id:
                raise HuabuArchiveError(f"存在重复的节点键：{node_key!r}")

            clean_data = _sanitize_node_data(spec.get("data"))
            raw_status = str(spec.get("status") or "idle")
            has_media = bool(clean_data.get("mediaId")) or any(
                bool(m) for m in (clean_data.get("mediaIds") or [])
            )
            if has_media:
                status = "done"
            elif node_type in ("prompt", "note") and raw_status == "done":
                status = "done"
            else:
                status = "idle"

            short_id = generate_unique_short_id(s, board.id)
            node = Node(
                board_id=board.id,
                short_id=short_id,
                type=node_type,
                x=_clamp(spec.get("x"), _COORD_MIN, _COORD_MAX, 0.0),
                y=_clamp(spec.get("y"), _COORD_MIN, _COORD_MAX, 0.0),
                w=_clamp(spec.get("w"), 1.0, _SIZE_MAX, 240.0),
                h=_clamp(spec.get("h"), 1.0, _SIZE_MAX, 160.0),
                data=clean_data,
                status=status,
            )
            s.add(node)
            s.flush()
            assert node.id is not None
            key_to_id[node_key] = node.id
            created_nodes.append(node)

        created_edges: list[Edge] = []
        for edge_spec in edges_spec:
            if not isinstance(edge_spec, dict):
                continue
            src_key = str(edge_spec.get("source_key") if edge_spec.get("source_key") is not None else "")
            dst_key = str(edge_spec.get("target_key") if edge_spec.get("target_key") is not None else "")
            src_id = key_to_id.get(src_key)
            dst_id = key_to_id.get(dst_key)
            if src_id is None or dst_id is None or src_id == dst_id:
                continue
            raw_sv = edge_spec.get("source_variant_idx")
            sv_idx = (
                raw_sv
                if isinstance(raw_sv, int) and not isinstance(raw_sv, bool) and raw_sv >= 0
                else None
            )
            edge = Edge(
                board_id=board.id,
                source_id=src_id,
                target_id=dst_id,
                kind="ref",
                source_variant_idx=sv_idx,
            )
            s.add(edge)
            created_edges.append(edge)

        s.commit()
        s.refresh(board)

    return {
        "board": board,
        "nodes_count": len(created_nodes),
        "edges_count": len(created_edges),
        "media_count": media_count,
    }


def export_board_huabu(board_id: int, *, include_media: bool = True) -> tuple[bytes, str]:
    """Serialize a board into a sanitized ``.huabu`` ZIP archive."""
    with get_session() as s:
        board = s.get(Board, board_id)
        if board is None:
            raise LookupError("board not found")
        nodes = s.exec(
            select(Node).where(Node.board_id == board_id).order_by(Node.id)
        ).all()
        edges = s.exec(
            select(Edge).where(Edge.board_id == board_id).order_by(Edge.id)
        ).all()

    node_id_to_key: dict[int, str] = {}
    for idx, node in enumerate(nodes, start=1):
        assert node.id is not None
        node_id_to_key[node.id] = f"n{idx}"

    bundled_media: dict[str, tuple[Path, str, str]] = {}
    total_media_bytes = 0
    if include_media:
        candidate_ids: list[str] = []
        seen_ids: set[str] = set()
        for node in nodes:
            data = node.data or {}
            raw_mids: list[Any] = []
            if isinstance(data.get("mediaId"), str):
                raw_mids.append(data["mediaId"])
            if isinstance(data.get("mediaIds"), list):
                raw_mids.extend(data["mediaIds"])
            for mid in raw_mids:
                if (
                    isinstance(mid, str)
                    and mid not in seen_ids
                    and media_service.is_valid_media_id(mid)
                ):
                    seen_ids.add(mid)
                    candidate_ids.append(mid)

        for mid in candidate_ids:
            cached = media_service.cached_path(mid)
            if cached is None or not cached.is_file():
                continue
            try:
                size = cached.stat().st_size
            except OSError:
                continue
            if size <= 0 or total_media_bytes + size > MAX_EXPORT_MEDIA_BYTES:
                continue
            ext = cached.suffix.lower()
            mime = _EXT_MIME.get(ext, "application/octet-stream")
            kind = "video" if mime.startswith("video/") else "image"
            bundled_media[mid] = (cached, mime, kind)
            total_media_bytes += size

    exported_nodes: list[dict[str, Any]] = []
    for node in nodes:
        assert node.id is not None
        clean_data = _sanitize_node_data(node.data)

        orig_mid = clean_data.get("mediaId")
        orig_mids = clean_data.get("mediaIds")

        kept_mid = orig_mid if isinstance(orig_mid, str) and orig_mid in bundled_media else None
        kept_mids: Optional[list[Optional[str]]] = None
        if isinstance(orig_mids, list):
            mapped = [
                m if isinstance(m, str) and m in bundled_media else None
                for m in orig_mids
            ]
            if any(mapped):
                kept_mids = mapped
                if kept_mid is None:
                    kept_mid = next((m for m in mapped if m), None)

        if kept_mid is not None:
            clean_data["mediaId"] = kept_mid
        else:
            clean_data.pop("mediaId", None)

        if kept_mids is not None:
            clean_data["mediaIds"] = kept_mids
        else:
            clean_data.pop("mediaIds", None)

        has_bundled_media = bool(kept_mid) or bool(kept_mids)
        if not has_bundled_media:
            clean_data.pop("renderedAt", None)
            export_status = "done" if node.type in ("prompt", "note") and node.status == "done" else "idle"
        else:
            export_status = "done"

        exported_nodes.append(
            {
                "key": node_id_to_key[node.id],
                "type": node.type,
                "x": node.x,
                "y": node.y,
                "w": node.w,
                "h": node.h,
                "status": export_status,
                "data": clean_data,
            }
        )

    exported_edges: list[dict[str, Any]] = []
    for edge in edges:
        src_key = node_id_to_key.get(edge.source_id)
        dst_key = node_id_to_key.get(edge.target_id)
        if not src_key or not dst_key:
            continue
        exported_edges.append(
            {
                "source_key": src_key,
                "target_key": dst_key,
                "kind": "ref",
                "source_variant_idx": edge.source_variant_idx,
            }
        )

    media_manifest: list[dict[str, str]] = []
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for mid, (cached, mime, kind) in bundled_media.items():
            archive_path = f"media/{mid}{cached.suffix.lower()}"
            zf.write(cached, arcname=archive_path)
            media_manifest.append(
                {
                    "media_id": mid,
                    "archive_path": archive_path,
                    "mime": mime,
                    "kind": kind,
                }
            )

        manifest = {
            "format": HUABU_FORMAT,
            "version": HUABU_SCHEMA_VERSION,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "board": {"name": board.name},
            "nodes": exported_nodes,
            "edges": exported_edges,
            "media": media_manifest,
        }
        zf.writestr(
            "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
        )

    return buf.getvalue(), _safe_filename(board.name)


def import_board_huabu(
    raw_zip: bytes,
    *,
    target_board_id: Optional[int] = None,
) -> dict[str, Any]:
    """Validate and import a ``.huabu`` archive into the local workspace."""
    if not raw_zip or len(raw_zip) > MAX_ARCHIVE_BYTES:
        raise HuabuArchiveError("上传的 .huabu 配方包为空或超过 150 MB 大小限制。")

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_zip), "r")
    except zipfile.BadZipFile as exc:
        raise HuabuArchiveError("无法解析 .huabu 文件：不是有效的画布归档包。") from exc

    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_ARCHIVE_ENTRIES:
            raise HuabuArchiveError(".huabu 归档内文件数量过多，已被安全拦截。")
        if sum(max(0, info.file_size) for info in infos) > MAX_UNCOMPRESSED_BYTES:
            raise HuabuArchiveError(".huabu 归档解压后体积超过 250 MB 安全限制。")

        by_name: dict[str, zipfile.ZipInfo] = {}
        for info in infos:
            fname = info.filename
            if (
                not fname
                or fname.startswith("/")
                or "\\" in fname
                or ".." in Path(fname).parts
            ):
                raise HuabuArchiveError("归档内存在非法路径，已拒绝导入。")
            if not info.is_dir():
                by_name[fname] = info

        manifest_info = by_name.get("manifest.json")
        if manifest_info is None:
            raise HuabuArchiveError("无效的 .huabu 配方包：缺少 manifest.json。")
        if manifest_info.file_size > MAX_MANIFEST_BYTES:
            raise HuabuArchiveError("manifest.json 体积异常，已拒绝导入。")

        try:
            manifest = json.loads(zf.read(manifest_info).decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise HuabuArchiveError("manifest.json 无法解析为有效 JSON。") from exc

        if not isinstance(manifest, dict) or manifest.get("format") != HUABU_FORMAT:
            raise HuabuArchiveError("不是有效的 AI Canvas Studio .huabu 创作配方包。")

        nodes_spec = manifest.get("nodes")
        edges_spec = manifest.get("edges") or []
        if not isinstance(nodes_spec, list) or not isinstance(edges_spec, list):
            raise HuabuArchiveError("manifest.json 缺少有效的节点或连线定义。")

        ingested_media = 0
        raw_media = manifest.get("media") or []
        if isinstance(raw_media, list):
            for entry in raw_media:
                if not isinstance(entry, dict):
                    continue
                mid = entry.get("media_id")
                archive_path = entry.get("archive_path")
                if (
                    not isinstance(mid, str)
                    or not media_service.is_valid_media_id(mid)
                    or not isinstance(archive_path, str)
                    or not archive_path.startswith("media/")
                ):
                    continue
                zinfo = by_name.get(archive_path)
                if zinfo is None or zinfo.file_size <= 0 or zinfo.file_size > MAX_EXPORT_MEDIA_BYTES:
                    continue
                raw_bytes = zf.read(zinfo)
                sniffed_mime = _sniff_media_mime(raw_bytes)
                if not sniffed_mime:
                    continue
                if media_service.cached_path(mid) is None:
                    kind = "video" if sniffed_mime.startswith("video/") else "image"
                    if media_service.ingest_inline_bytes(mid, raw_bytes, kind=kind, mime=sniffed_mime):
                        ingested_media += 1

        board_meta = manifest.get("board") if isinstance(manifest.get("board"), dict) else {}
        board_name = str(board_meta.get("name") or "导入的工作流").strip() or "导入的工作流"
        return instantiate_board_recipe(
            name=board_name,
            nodes_spec=nodes_spec,
            edges_spec=edges_spec,
            target_board_id=target_board_id,
            media_count=ingested_media,
        )
