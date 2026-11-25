"""Auto-prompt route.

`POST /api/prompt/auto { node_id }` returns a Claude-composed prompt built
from the immediate-upstream context (character / visual_asset / image
nodes' aiBriefs). Frontend calls this when the user clicks Generate
without typing a prompt.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from .local_only import local_origin
from pydantic import BaseModel, Field

from flowboard.services import prompt_synth
from flowboard.services.llm.base import LLMError
from flowboard.services.llm.registry import run_llm
from flowboard.services.prompt_safety import (
    SAFETY_SYSTEM_POLICY_CLAUSE,
    sanitize_prompt_for_flow_safety,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prompt", tags=["prompt"], dependencies=[Depends(local_origin)])


class AutoPromptBody(BaseModel):
    node_id: int
    # Optional video-only constraint: e.g. "static" → synth uses the camera-
    # locked system prompt and avoids dolly/zoom suggestions.
    camera: Optional[str] = None
    seed_prompt: Optional[str] = None
    allow_fallback: bool = False
    duration_s: Optional[int] = None
    silent_video: bool = False


class AutoPromptResponse(BaseModel):
    node_id: int
    prompt: str
    safety_rewritten: bool = False
    safety_notes: list[str] = Field(default_factory=list)


@router.post("/auto", response_model=AutoPromptResponse)
async def auto_prompt(body: AutoPromptBody) -> AutoPromptResponse:
    kwargs: dict[str, object] = {"camera": body.camera}
    if body.seed_prompt is not None:
        kwargs["seed_prompt"] = body.seed_prompt
    if body.allow_fallback:
        kwargs["allow_fallback"] = True
    if body.duration_s is not None:
        kwargs["duration_s"] = body.duration_s
    if body.silent_video:
        kwargs["silent_video"] = True
    prompt_synth.reset_safety_audit_ctx()
    try:
        text = await prompt_synth.auto_prompt(body.node_id, **kwargs)  # type: ignore[arg-type]
    except prompt_synth.PromptSynthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    rewritten, notes = prompt_synth.get_safety_audit_ctx()
    return AutoPromptResponse(
        node_id=body.node_id,
        prompt=text,
        safety_rewritten=rewritten,
        safety_notes=notes,
    )


class AutoPromptBatchBody(BaseModel):
    node_id: int
    count: int
    camera: Optional[str] = None
    seed_prompt: Optional[str] = None
    allow_fallback: bool = False


class AutoPromptBatchResponse(BaseModel):
    node_id: int
    prompts: list[str]
    safety_rewritten: bool = False
    safety_notes: list[str] = Field(default_factory=list)


@router.post("/auto-batch", response_model=AutoPromptBatchResponse)
async def auto_prompt_batch(body: AutoPromptBatchBody) -> AutoPromptBatchResponse:
    """Return N pose-distinct prompts so that an N-variant image gen
    actually produces N different shots instead of N seeds of the same
    stance."""
    if body.count < 1 or body.count > 8:
        raise HTTPException(status_code=400, detail="count must be 1..8")
    kwargs: dict[str, object] = {"camera": body.camera}
    if body.seed_prompt is not None:
        kwargs["seed_prompt"] = body.seed_prompt
    if body.allow_fallback:
        kwargs["allow_fallback"] = True
    prompt_synth.reset_safety_audit_ctx()
    try:
        prompts = await prompt_synth.auto_prompt_batch(
            body.node_id,
            body.count,
            **kwargs,  # type: ignore[arg-type]
        )
    except prompt_synth.PromptSynthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    rewritten, notes = prompt_synth.get_safety_audit_ctx()
    return AutoPromptBatchResponse(
        node_id=body.node_id,
        prompts=prompts,
        safety_rewritten=rewritten,
        safety_notes=notes,
    )


class ScriptBreakdownBody(BaseModel):
    script: str
    shot_count: int = 4
    aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE"


class ScriptShotSpec(BaseModel):
    title: str
    image_prompt: str
    video_prompt: str
    camera: str


class ScriptBreakdownResponse(BaseModel):
    title: str
    character_prompt: str
    shots: list[ScriptShotSpec]
    source: str


_CAMERA_ROTATION = (
    "固定全景定场",
    "缓慢推近特写",
    "环绕中景跟拍",
    "手持跟随动态",
    "摇臂升格俯仰",
    "拉远氛围尾镜",
)


def _offline_script_breakdown(script: str, count: int) -> ScriptBreakdownResponse:
    clean = sanitize_prompt_for_flow_safety(re.sub(r"\s+", " ", script).strip()).text
    parts = [p.strip() for p in re.split(r"[。！？\n；;]+", clean) if p.strip()]
    if not parts:
        parts = [clean]
    short_title = (parts[0][:16] + "…") if len(parts[0]) > 16 else parts[0]
    shots: list[ScriptShotSpec] = []
    for idx in range(count):
        beat = parts[idx % len(parts)] if len(parts) > 1 else parts[0]
        cam = _CAMERA_ROTATION[idx % len(_CAMERA_ROTATION)]
        phase_tag = (
            "开篇建立环境氛围"
            if idx == 0
            else "情绪推高与核心动作展示"
            if idx < count - 1
            else "戏剧收尾与余韵留白"
        )
        img_prompt = sanitize_prompt_for_flow_safety(
            f"第 {idx + 1} 镜（{phase_tag}）：围绕「{beat}」，保持 ref_image_1 主角外貌与服装一致性，"
            f"电影级真实光影与景深层次，采用{cam}构图视角"
        ).text
        vid_prompt = sanitize_prompt_for_flow_safety(
            f"基于当前画面演绎「{beat}」{phase_tag}动态镜头，{cam}，人物动作连贯自然，电影胶片质感与真实物理光影流动"
        ).text
        shots.append(
            ScriptShotSpec(
                title=f"镜头 {idx + 1}",
                image_prompt=img_prompt,
                video_prompt=vid_prompt,
                camera=cam,
            )
        )
    char_prompt = sanitize_prompt_for_flow_safety(
        f"电影级主角三视图与核心造型设定，源于故事主题：{clean[:120]}，五官清晰、服化道质感统一"
    ).text
    return ScriptBreakdownResponse(
        title=short_title or "AI 剧本分镜",
        character_prompt=char_prompt,
        shots=shots,
        source="fallback",
    )


def _extract_json_block(text: str) -> Optional[dict]:
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not m:
        return None
    try:
        parsed = json.loads(m.group(0))
        return parsed if isinstance(parsed, dict) else None
    except Exception:  # noqa: BLE001
        return None


@router.post("/script-breakdown", response_model=ScriptBreakdownResponse)
async def script_breakdown(body: ScriptBreakdownBody) -> ScriptBreakdownResponse:
    clean = (body.script or "").strip()
    if not clean:
        raise HTTPException(status_code=400, detail="请输入创意故事或产品脚本后再拆解分镜。")
    count = max(2, min(9, int(body.shot_count or 4)))

    sys_prompt = (
        "你是资深 AI 影视导演兼分镜师。请将用户的中文故事或创意脚本拆解为"
        f"严格 {count} 个分镜的 JSON 结构，严格使用简体中文。\n"
        "必须只输出纯 JSON 对象，不要有任何 Markdown 解释文字：\n"
        '{\n'
        '  "title": "短片标题(<=16字)",\n'
        '  "character_prompt": "主角外貌、发型、服饰与美术画风完整设定词",\n'
        '  "shots": [\n'
        '    {\n'
        '      "title": "镜头 1",\n'
        '      "image_prompt": "结合 ref_image_1 主角一致性的高清静态分镜画面提示词",\n'
        '      "video_prompt": "衔接该分镜画面的动态运镜与人物动作视频提示词",\n'
        '      "camera": "镜头运动标签（如 缓慢推近 / 环绕跟拍 / 固定全景）"\n'
        '    }\n'
        '  ]\n'
        '}'
        + SAFETY_SYSTEM_POLICY_CLAUSE
    )
    try:
        raw = await run_llm(
            "auto_prompt",
            f"画幅：{body.aspect_ratio}\n期望分镜数：{count}\n创意脚本：\n{clean}",
            system_prompt=sys_prompt,
            timeout=45.0,
        )
        data = _extract_json_block(raw or "")
        if data and isinstance(data.get("shots"), list) and data["shots"]:
            parsed_shots: list[ScriptShotSpec] = []
            for idx, item in enumerate(data["shots"][:count]):
                if not isinstance(item, dict):
                    continue
                img_p = sanitize_prompt_for_flow_safety(str(item.get("image_prompt") or "").strip()).text
                vid_p = sanitize_prompt_for_flow_safety(str(item.get("video_prompt") or img_p).strip()).text
                if not img_p:
                    continue
                parsed_shots.append(
                    ScriptShotSpec(
                        title=str(item.get("title") or f"镜头 {idx + 1}")[:40],
                        image_prompt=img_p,
                        video_prompt=vid_p,
                        camera=str(item.get("camera") or _CAMERA_ROTATION[idx % len(_CAMERA_ROTATION)])[:32],
                    )
                )
            if parsed_shots:
                return ScriptBreakdownResponse(
                    title=str(data.get("title") or "AI 剧本分镜")[:60],
                    character_prompt=sanitize_prompt_for_flow_safety(
                        str(data.get("character_prompt") or clean[:120])
                    ).text,
                    shots=parsed_shots,
                    source="llm",
                )
    except (LLMError, Exception):  # noqa: BLE001
        pass

    return _offline_script_breakdown(clean, count)
