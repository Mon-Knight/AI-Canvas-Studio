"""Unit & integration tests for AI polish content-safety audit & automatic rewrite."""
from __future__ import annotations

import pytest

from flowboard.services import prompt_synth
from flowboard.services.llm.base import LLMError
from flowboard.services.prompt_safety import (
    SAFETY_SYSTEM_POLICY_CLAUSE,
    sanitize_prompt_for_flow_safety,
)


def test_sanitize_rewrites_rooftop_fall_prompt():
    raw = (
        "0-3秒，ref_image_1中的动漫少女立于天台边缘，强风呼啸；"
        "4-8秒，她眼神毫无迟疑，毅然向后仰身纵入苍茫夜空，身体在失重气流中向深处坠落。"
    )
    res = sanitize_prompt_for_flow_safety(raw)
    assert res.rewritten is True
    assert len(res.notes) >= 1
    assert "纵入苍茫夜空" not in res.text
    assert "失重气流中向深处坠落" not in res.text
    assert "ref_image_1" in res.text
    assert "夜空" in res.text


def test_sanitize_rewrites_gore_weapons_nsfw_and_violent_dialogue():
    raw = "黑暗中鲜血四溅，反派开枪射击并大喊杀了你们，画面呈现裸体剪影。"
    res = sanitize_prompt_for_flow_safety(raw)
    assert res.rewritten is True
    assert len(res.notes) >= 3
    for forbidden in ("鲜血四溅", "开枪射击", "杀了你们", "裸体"):
        assert forbidden not in res.text


def test_sanitize_rewrites_english_unsafe_terms():
    raw = "A girl jumping off a rooftop with blood splatter and a gunshot."
    res = sanitize_prompt_for_flow_safety(raw)
    assert res.rewritten is True
    assert "jumping off a rooftop" not in res.text.lower()
    assert "blood splatter" not in res.text.lower()
    assert "gunshot" not in res.text.lower()


def test_sanitize_leaves_clean_prompts_untouched():
    raw = "ref_image_1中的动漫少女在海边花海中微笑起舞，长发随微风轻扬，暖金色夕阳逆光。"
    res = sanitize_prompt_for_flow_safety(raw)
    assert res.rewritten is False
    assert res.notes == []
    assert res.text == raw


def test_auto_prompt_route_applies_safety_audit_on_llm_and_fallback(client, monkeypatch):
    board = client.post("/api/boards", json={"name": "Safety Test"}).json()
    node = client.post(
        "/api/nodes",
        json={"board_id": board["id"], "type": "video", "x": 0, "y": 0, "data": {"title": "视频"}},
    ).json()

    # 1. LLM receives safety compliance clause and unsafe LLM output is auto-sanitized.
    captured_sys: list[str] = []

    async def fake_run_llm(feature, user_msg, *, system_prompt=None, timeout=60.0):
        captured_sys.append(system_prompt or "")
        return "动漫少女站在天台边缘，突然跳楼并伴随鲜血四溅的慢动作镜头。"

    monkeypatch.setattr(prompt_synth, "run_llm", fake_run_llm)
    resp = client.post(
        "/api/prompt/auto",
        json={"node_id": node["id"], "seed_prompt": "少女跳楼"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["safety_rewritten"] is True
    assert len(body["safety_notes"]) >= 2
    assert "跳楼" not in body["prompt"]
    assert "鲜血四溅" not in body["prompt"]
    assert captured_sys and SAFETY_SYSTEM_POLICY_CLAUSE.strip() in captured_sys[0]

    # 2. Offline fallback path also auto-sanitizes risky seed_prompt and flags safety_rewritten.
    async def failing_run_llm(*args, **kwargs):
        raise LLMError("provider unavailable")

    monkeypatch.setattr(prompt_synth, "run_llm", failing_run_llm)
    resp2 = client.post(
        "/api/prompt/auto",
        json={
            "node_id": node["id"],
            "seed_prompt": "少女毅然向后仰身纵入苍茫夜空，身体在失重气流中向深处坠落",
            "allow_fallback": True,
        },
    )
    assert resp2.status_code == 200
    body2 = resp2.json()
    assert body2["safety_rewritten"] is True
    assert "纵入苍茫夜空" not in body2["prompt"]
    assert "失重气流中向深处坠落" not in body2["prompt"]
