"""Bind a payable canvas video job to the local Flow profile the user selected."""
from flowboard.services import flow_accounts
from flowboard.services.flow_sdk import resolve_paygate_tier
from flowboard.services.ws_server import selected_tab_connected

TYPES = frozenset(
    {
        "gen_video",
        "gen_video_omni",
        "gen_video_first_last",
        "gen_video_text",
    }
)
WRONG_ENGINE = "视频仅使用当前 Flow 账号，请在节点上重新确认生成。"


def confirmed_params(params: dict, confirmed_account: str | None) -> dict:
    """Called on enqueue and again before dispatch. Never infer a different payer."""
    if params.get("media_provider", "flow") != "flow":
        raise ValueError(WRONG_ENGINE)
    account_id, project_id = flow_accounts.active_binding()
    if not account_id:
        raise ValueError("请先在右上角选择 Flow 账号。")
    if not confirmed_account or account_id != confirmed_account:
        raise ValueError("Flow 账号已变化，请在节点上重新确认生成。")
    if not project_id or project_id != params.get("project_id"):
        raise ValueError("Flow 项目尚未绑定或已变化，请检查账号设置后重新提交。")
    if not selected_tab_connected(account_id):
        raise ValueError("当前 Flow 账号未连接，请打开对应的 Flow 网页并连接扩展。")
    try:
        tier = resolve_paygate_tier()
    except ValueError:
        raise ValueError("请先在账号设置中配置正确的 Flow 套餐。") from None
    return {**params, "media_provider": "flow", "flow_account_id": account_id, "paygate_tier": tier}
