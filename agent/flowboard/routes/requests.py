from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request as HTTPRequest
from pydantic import BaseModel, Field

from flowboard.db import get_session
from flowboard.db.models import Node, Request
from flowboard.routes.local_only import local_origin
from sqlmodel import select
from flowboard.services import video_routing
from flowboard.worker.processor import _media_provider_of, get_worker

router = APIRouter(prefix="/api/requests", tags=["requests"])


class RequestCreate(BaseModel):
    node_id: Optional[int] = None
    type: str = Field(min_length=1, max_length=40)
    params: dict[str, Any] = Field(default_factory=dict)
    flow_account_id: str | None = None


@router.post("")
async def create_request(body: RequestCreate, request: HTTPRequest):
    from flowboard.services.flow_accounts import active_binding
    from flowboard.services.flow_client import flow_client

    params = dict(body.params)
    video = body.type in video_routing.TYPES
    if video or params.get("media_provider") == "google_video":
        local_origin(request)
        if params.get("media_provider", "flow") != "flow":
            # Reject obsolete clients instead of charging an unexpected provider.
            raise HTTPException(422, video_routing.WRONG_ENGINE)
    if video:
        valid_fields = {
            "media_provider",
            "project_id",
            "prompt",
            "paygate_tier",
            "aspect_ratio",
            "video_quality",
            "start_media_id",
            "start_media_ids",
            "startMediaId",
            "end_media_id",
            "endMediaId",
            "duration_s",
            "ref_media_ids",
            "variant_count",
            "resolution",
            "omni_version",
        }
        if params.keys() - valid_fields:
            raise HTTPException(422, "视频任务包含不支持的字段；请刷新画布后重试。")
        # No await between validating the active binding and committing the row:
        # once queued it prevents an account/project change until settlement.
        try:
            params = video_routing.confirmed_params(params, body.flow_account_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
    account_id, project_id = active_binding()
    managed = account_id is not None
    music_types = ("gen_music", "edit_music", "split_stems", "effect_music")
    is_music = body.type in music_types
    uses_flow = not video and body.type in ("gen_image", "edit_image", "create_project") and _media_provider_of(params) != "muse"
    if managed and body.type == "proxy":
        raise HTTPException(409, "独立账号模式仅支持画布内的 Flow 生成与上传。")
    if uses_flow and (managed or body.flow_account_id is not None) and body.flow_account_id != account_id:
        raise HTTPException(409, "Flow 账号已切换，请重新提交任务。")
    if is_music and body.flow_account_id is not None and body.flow_account_id != account_id:
        raise HTTPException(409, "Google 账号已切换，请重新提交音乐任务。")
    if managed and uses_flow:
        if not project_id or not flow_client.connected:
            raise HTTPException(409, "请先绑定项目，并在当前账号窗口打开 Flow、连接扩展。")
        if body.type != "create_project" and body.params.get("project_id") != project_id:
            raise HTTPException(409, "Flow 账号或项目已切换，请重新提交任务。")
    with get_session() as s:
        if body.node_id is not None:
            node = s.get(Node, body.node_id)
            if node is None:
                raise HTTPException(404, "node not found")
            if video:
                if node.type != "video":
                    raise HTTPException(422, "请选择视频节点提交视频生成任务。")
                pending = s.exec(select(Request.id).where(
                    Request.node_id == node.id, Request.type.in_(video_routing.TYPES),
                    Request.status.in_(("queued", "running")),
                ).limit(1)).first()
                if pending is not None:
                    raise HTTPException(409, "该节点已有视频任务，请等待完成后再提交。")
                # Persist queue state in the same transaction as the request;
                # another tab/reload can show it before the worker starts.
                node.status = "queued"
                s.add(node)
            elif is_music:
                if node.type != "audio":
                    raise HTTPException(422, "请选择音频节点提交音乐生成或编辑任务。")
                pending_music = s.exec(select(Request.id).where(
                    Request.node_id == node.id, Request.type.in_(music_types),
                    Request.status.in_(("queued", "running")),
                ).limit(1)).first()
                if pending_music is not None:
                    raise HTTPException(409, "该音频节点已有音乐任务在运行，请等待完成后再提交。")
                node.status = "queued"
                s.add(node)
        req = Request(
            node_id=body.node_id,
            type=body.type,
            params=params,
            status="queued",
        )
        s.add(req)
        s.commit()
        s.refresh(req)
        rid = req.id
        row = req

    assert rid is not None
    get_worker().enqueue(rid)
    return row


@router.get("/{request_id}")
def get_request(request_id: int):
    with get_session() as s:
        req = s.get(Request, request_id)
        if req is None:
            raise HTTPException(404, "request not found")
        return req


@router.post("/{request_id}/cancel")
def cancel_request(request_id: int):
    """Cancel a ``queued`` or ``running`` request.

    Cancellation is cooperative on the running side: we can't abort an
    in-flight HTTP call to Flow, but the long-running handlers (notably
    ``_handle_gen_video``) re-read the row between polls and bail out
    when they see ``status == 'canceled'``. The worker's ``_process_one``
    also re-checks the row before its final stamp, so the canceled
    status is never overwritten by a late-arriving result.
    """
    with get_session() as s:
        req = s.get(Request, request_id)
        if req is None:
            raise HTTPException(404, "request not found")
        if req.status not in ("queued", "running"):
            raise HTTPException(
                409,
                f"only queued or running requests can be canceled (status={req.status})",
            )
        req.status = "canceled"
        req.error = "canceled"
        req.finished_at = datetime.now(timezone.utc)
        s.add(req)
        # Clear the node's in-flight stamp here rather than in the worker.
        # The worker mirrors Node.status on every transition it makes, but
        # it deliberately leaves canceled rows alone (a late-arriving result
        # must not resurrect them), so a cancel is the one transition out of
        # `running` it never sees. Without this the card would sit on the
        # processing UI forever after a reload, with no request left to
        # poll. Mirrors what the frontend poll does on `canceled`: back to
        # idle, keeping whatever the node was showing before.
        if req.node_id is not None:
            node = s.get(Node, req.node_id)
            if node is not None and node.status in ("queued", "running"):
                node.status = "idle"
                s.add(node)
        s.commit()
        s.refresh(req)
        return req
