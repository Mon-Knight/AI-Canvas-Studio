import type { ChatMode } from "../api/client";
import type { FlowNode } from "../store/board";

const MENTION_RE = /#([a-zA-Z0-9_-]{1,8})/g;
export const MAX_CHAT_MENTIONS = 32;

export function extractMentions(text: string): string[] {
  const matches = text.matchAll(MENTION_RE);
  return [...matches].map((m) => m[1]);
}

export function resolveNodePrimaryMedia(
  node: FlowNode,
): { mediaId: string; isVideo: boolean } | null {
  const isVideo = node.data.type === "video";
  if (typeof node.data.mediaId === "string" && node.data.mediaId.length > 0) {
    return { mediaId: node.data.mediaId, isVideo };
  }
  const fromList = (node.data.mediaIds ?? []).find(
    (m): m is string => typeof m === "string" && m.length > 0,
  );
  if (fromList) {
    return { mediaId: fromList, isVideo };
  }
  return null;
}

export interface ActiveCanvasRef {
  node: FlowNode;
  source: "selected" | "pinned";
}

/**
 * 汇总当前对话草稿自动引用的画布节点：
 * 1. 画布当前选中（`node.selected === true`）且未被用户手动点 `×` 忽略的节点自动进入引用栏；
 * 2. 用户通过「+ 引用节点」或 `#` 菜单额外固定的节点合并去重；
 * 3. 总数不超过后端单条消息 32 个节点上限。
 */
export function resolveActiveCanvasReferences(
  nodes: readonly FlowNode[],
  mutedSelectedIds: ReadonlySet<string>,
  pinnedNodeIds: readonly string[],
): ActiveCanvasRef[] {
  const out: ActiveCanvasRef[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (!node.selected || mutedSelectedIds.has(node.id)) continue;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push({ node, source: "selected" });
    if (out.length >= MAX_CHAT_MENTIONS) return out;
  }

  for (const rfId of pinnedNodeIds) {
    if (seen.has(rfId)) continue;
    const node = nodes.find((n) => n.id === rfId);
    if (!node) continue;
    seen.add(node.id);
    out.push({ node, source: "pinned" });
    if (out.length >= MAX_CHAT_MENTIONS) return out;
  }

  return out;
}

/**
 * 合并引用栏中的画布节点 `shortId` 与输入框正文手写的 `#shortId`，过滤无效编号并保持顺序去重。
 */
export function mergeChatMentions(
  text: string,
  referencedNodes: ReadonlyArray<{ node: FlowNode }>,
  allNodes: readonly FlowNode[],
): string[] {
  const known = new Set(allNodes.map((n) => n.data.shortId));
  const combined = [
    ...referencedNodes.map((r) => r.node.data.shortId),
    ...extractMentions(text),
  ];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const id of combined) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

export function buildDefaultNodeChatMessage(
  mode: ChatMode,
  referencedShortIds: readonly string[],
): string {
  if (referencedShortIds.length > 0) {
    const tagList = referencedShortIds.map((id) => `#${id}`).join("、");
    return mode === "analyze"
      ? `请结合当前引用的画布节点（${tagList}）分析画面画风、主体特征、构图光影，并给出可执行的提示词或运镜建议。`
      : `请基于当前引用的画布节点（${tagList}）规划并创建下一步关联画面或视频节点。`;
  }
  return mode === "analyze"
    ? "请分析这些参考图的构图、光线与运镜，并给出视频提示词建议。"
    : "请结合参考图规划并创建画面与视频节点。";
}
