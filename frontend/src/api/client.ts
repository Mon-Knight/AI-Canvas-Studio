export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<T>;
}

// Map cryptic Flow / pipeline error tokens to a sentence the user can act on.
// Returns null when the token is unrecognised, so the caller falls through to
// the raw message.
export function humanizeBackendError(token: string): string | null {
  const t = token.toLowerCase();
  const isDesktop =
    typeof window !== "undefined" &&
    Boolean((window as { flowboardDesktop?: unknown }).flowboardDesktop);

  if (t.startsWith("paygate_tier_invalid")) {
    return (
      "暂未识别当前配置的 Google Flow 套餐等级。请在「右上角头像 → Flow 账号与积分」中选择 Pro / Ultra，或在根目录 .env 中将 FLOWBOARD_PAYGATE_TIER 设为 PAYGATE_TIER_TWO（Ultra）或 PAYGATE_TIER_ONE（Pro）后重启本地服务。"
    );
  }
  if (t.includes("no_flow_project")) {
    return isDesktop
      ? "当前账号尚未绑定 Flow 项目。请点击「右上角头像 → Flow 账号与积分 → 登录并绑定项目」，在内层窗口中点开或新建任意项目即可自动绑定。"
      : "尚未绑定可用的 Flow 项目。请前往 flow.google.com 打开一个项目，复制其地址或项目 ID 后粘贴到「右上角头像 → Flow 账号与积分」（或「右上角 ··· → 生成引擎与项目设置」）中保存。";
  }
  if (t.includes("unsupported_on_batch_api")) {
    return `${token} — 当前 Google Flow 接口暂不支持该能力，重试无法恢复。`;
  }
  if (t.includes("no_at_token")) {
    return isDesktop
      ? "内层 Flow 引擎尚未完成登录或页面签名初始化。请点击「右上角头像 → 登录并绑定项目」确认 Google 登录状态，或点击「右上角 ··· → 刷新内层 Flow 引擎」。"
      : "Flow 网页已打开但尚未完成初始化签名。请刷新 https://flow.google.com/ 页面等待界面完全加载后再试。";
  }
  if (t.includes("no_flow_tab") || t.includes("flow_tab_discarded") || t === "extension_disconnected") {
    return isDesktop
      ? "内层 Flow 浏览器尚未就绪或需要登录验证。请打开「右上角头像 → Flow 账号与积分」完成 Google 登录，登录后将自动在后台静默运行。"
      : "需要保持一个已登录的 https://flow.google.com/ 浏览器标签页处于开启状态以便页面签名请求。请打开对应窗口的 Flow 标签页后重试。";
  }
  if (t === "no_media_id_in_upload_response") {
    return (
      "Google Flow 接收了上传请求但未返回媒体标识，通常是图片触发了安全过滤（如品牌标志、水印或版权素材）。请更换图片或本地下载后重新上传。"
    );
  }
  if (t.includes("captcha_failed: no current window")) {
    return (
      "当前 Chrome 没有可用于挂载 Flow 标签页的活动窗口。请先打开对应账号的 Chrome 窗口（或点击扩展里的「打开 Flow」）后重试。"
    );
  }
  if (t.startsWith("captcha_failed:")) {
    return `验证码校验失败：${token}`;
  }
  if (t.includes("public_error_unusual_activity")) {
    const refreshStep = isDesktop
      ? "① 点击「右上角头像 → Flow 账号与积分 → 登录并绑定项目」，刷新内层 Flow 页面并完成可能出现的安全验证；"
      : "① 切换到已登录的 Chrome 浏览器，手动刷新 flow.google.com 页面并完成可能出现的安全验证；";
    if (t.includes("sprcad")) {
      return [
        "Google Flow 对 2K/4K 高清重塑触发了安全风控（PUBLIC_ERROR_UNUSUAL_ACTIVITY）。",
        "解决方法：",
        refreshStep,
        "② 更换干净稳定的网络节点，避免中途切换 IP 或短时间连续点击重塑；",
        "③ 建议先用「1K 标准」生成，间隔几秒再点击「2K 重塑」，或前往 Flow 网页端导出高清图。",
      ].join("\n");
    }
    return [
      "Google Flow 触发了安全风控拦截（PUBLIC_ERROR_UNUSUAL_ACTIVITY）。",
      "解决方法：",
      refreshStep,
      "② 更换干净稳定的网络节点，避免短时间高频连点或中途切换 IP；",
      "③ 稍等片刻后重试。",
    ].join("\n");
  }
  const publicErrMatch = token.match(/PUBLIC_ERROR_[A-Z0-9_]+/i);
  if (publicErrMatch) {
    const code = publicErrMatch[0].toUpperCase();
    return code.replace(/^PUBLIC_ERROR_/, "Flow 内容或安全拦截：").replace(/_/g, " ");
  }
  if (t === "timeout_waiting_video") {
    return "视频生成等待超时（超过 5 分钟未返回成片，可能因 Flow 排队较久或提示词触发安全审核）";
  }
  if (t.includes("as29s") && t.includes("[5]")) {
    return "Flow 暂未找到对应视频媒体记录（as29s [5]），可能是任务仍在后台渲染或因安全策略拦截未生成成片。";
  }
  if (t.includes("rpcerror:") && t.includes("failed: [3]")) {
    return "Flow 接口拒绝了当前生成参数组合（错误码 [3]：例如 Veo 3.1 不支持 360p 草稿分辨率，仅支持 720p 起），请切换为 720p 标准清晰度后重试。";
  }
  if (t.includes("flowmusic_not_logged_in")) {
    return "当前账号尚未登录 Google Flow Music。请点击「开启 Flow Music 通道」在 Chrome 中完成一次 Google 登录即可使用个人音乐积分。";
  }
  if (t.includes("flowmusic_auth_expired")) {
    return "Flow Music 登录态已过期，请刷新 Chrome 中的 flowmusic.app 标签页后重试。";
  }
  if (t.includes("flowmusic_out_of_credits")) {
    return "当前账号的 Flow Music 音乐积分余额不足（生成一首约消耗 5 积分，分轨与裁剪免费）。";
  }
  if (t.includes("flowmusic_extension_disconnected")) {
    return "尚未检测到当前账号的 Chrome 扩展连接，请先在右上角确认托管 Chrome 与扩展在线。";
  }
  return null;
}

export async function extractErrorMessage(res: Response): Promise<string> {
  let detail: unknown;
  try {
    detail = await res.json();
  } catch {
    try {
      detail = await res.text();
    } catch {
      return `${res.status} ${res.statusText}`;
    }
  }
  const inner =
    typeof detail === "object" && detail !== null && "detail" in detail
      ? (detail as { detail: unknown }).detail
      : detail;
  if (typeof inner === "string" && inner) {
    return humanizeBackendError(inner) ?? inner;
  }
  if (inner && typeof inner === "object") {
    const obj = inner as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) {
      return humanizeBackendError(obj.message) ?? obj.message;
    }
    try {
      return JSON.stringify(inner);
    } catch {
      // fall through
    }
  }
  return `${res.status} ${res.statusText}`;
}

export interface WsStats {
  connected: boolean;
  flow_key_present: boolean;
  token_age_s: number | null;
  pending: number;
  request_count: number;
  success_count: number;
  failed_count: number;
  last_error: string | null;
}

export interface HealthResponse {
  ok: boolean;
  version?: string;
  frontend_dist?: string;
  extension_connected: boolean;
  ws_stats?: WsStats;
}

export function getHealth() {
  return api<HealthResponse>("/api/health");
}

// ── DTOs ────────────────────────────────────────────────────────────────────

export type NodeType = "character" | "image" | "video" | "audio" | "prompt" | "note" | "visual_asset" | "Storyboard" | "merge";
export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";

export interface Board {
  id: number;
  name: string;
  created_at: string;
}

export interface NodeDTO {
  id: number;
  board_id: number;
  short_id: string;
  type: NodeType;
  x: number;
  y: number;
  w: number;
  h: number;
  data: Record<string, unknown>;
  status: NodeStatus;
  created_at: string;
}

export interface EdgeDTO {
  id: number;
  board_id: number;
  source_id: number;
  target_id: number;
  kind: string;
  // null when the upstream is single-variant (or the edge hasn't been
  // pinned yet — natural fallback to source.mediaId at dispatch time).
  // 0-based index into the source node's `data.mediaIds[]` when the
  // user has explicitly picked a variant.
  source_variant_idx: number | null;
}

export interface BoardDetail {
  board: Board;
  nodes: NodeDTO[];
  edges: EdgeDTO[];
}

// ── API methods ──────────────────────────────────────────────────────────────

export function listBoards(): Promise<Board[]> {
  return api<Board[]>("/api/boards");
}

export function createBoard(name: string): Promise<Board> {
  return api<Board>("/api/boards", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getBoard(id: number): Promise<BoardDetail> {
  return api<BoardDetail>(`/api/boards/${id}`);
}

export function patchBoard(id: number, name: string): Promise<Board> {
  return api<Board>(`/api/boards/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteBoard(id: number): Promise<{ deleted: number }> {
  return api<{ deleted: number }>(`/api/boards/${id}`, { method: "DELETE" });
}

export function createNode(input: {
  board_id: number;
  type: NodeType;
  x: number;
  y: number;
  data?: object;
}): Promise<NodeDTO> {
  return api<NodeDTO>("/api/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Shallow-merge patch for `node.data` — the backend (see
 * agent/flowboard/routes/nodes.py::update_node) merges this dict into
 * the existing JSON column instead of replacing it.
 *
 * Conventions:
 *   - Keys present in the patch override existing values.
 *   - Keys absent from the patch are PRESERVED (this is what the type
 *     guarantees over a wholesale replace).
 *   - A value of `null` is the explicit "delete this key" sentinel.
 *     Use it instead of `undefined` to clear fields like `aiBrief`
 *     after a regen — `undefined` gets dropped by JSON.stringify and
 *     would leave the stale value in place after the merge.
 *   - Merge depth is ONE LEVEL. Nested dict values are wholesale-
 *     replaced, not deep-merged. None of FlowboardNodeData's current
 *     fields nest, so this is a non-issue today; revisit if a future
 *     field stores objects.
 *
 * Pre-merge call sites that built the full `data` from scratch and
 * forgot a sibling field caused a real data-loss regression
 * (`aspectRatio` was wiped on every image gen by the auto-brief
 * patch). Sticking to deltas-only with this type as the contract
 * prevents that whole class of bug.
 */
export type DataPatch = Record<string, unknown>;

export function patchNode(
  id: number,
  patch: Partial<
    Pick<Omit<NodeDTO, "data">, "x" | "y" | "w" | "h" | "status">
  > & { data?: DataPatch },
): Promise<NodeDTO> {
  return api<NodeDTO>(`/api/nodes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteNode(id: number): Promise<{ ok: true; deleted_edges: number[] }> {
  return api<{ ok: true; deleted_edges: number[] }>(`/api/nodes/${id}`, {
    method: "DELETE",
  });
}

export function createEdge(input: {
  board_id: number;
  source_id: number;
  target_id: number;
  kind?: string;
  source_variant_idx?: number | null;
}): Promise<EdgeDTO> {
  return api<EdgeDTO>("/api/edges", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Update an edge's variant pin without recreating it. Pass
 * `source_variant_idx: null` explicitly to clear the pin (revert to
 * the source's active mediaId at dispatch time). Omit the field to
 * leave it untouched.
 */
export function patchEdge(
  id: number,
  patch: { source_variant_idx?: number | null },
): Promise<EdgeDTO> {
  return api<EdgeDTO>(`/api/edges/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteEdge(id: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/edges/${id}`, {
    method: "DELETE",
  });
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export type ChatMode = "analyze" | "create";
export type ChatRole = "user" | "assistant" | "system";

export interface ChatAttachmentDTO {
  id: number;
  asset_id: number;
  mime: string;
  url: string;
}

export interface ChatMessageDTO {
  id: number;
  board_id: number;
  role: ChatRole;
  content: string;
  mentions: string[];
  attachments: ChatAttachmentDTO[];
  created_at: string;
}

export interface PlanDTO {
  id: number;
  board_id: number;
  spec: {
    nodes: Array<{ tmp_id?: string; type: string; params?: Record<string, unknown> }>;
    edges: Array<{ from: string; to: string; kind?: string }>;
    layout_hint?: string;
  };
  status: "draft" | "approved" | "running" | "done" | "failed";
  created_at: string;
}

// Dock flow: POST returns fast with the user message + run id; the agent
// loop runs server-side and the client polls the active run.
export interface ChatSendResponse {
  user: ChatMessageDTO;
  run_id: number;
}

export interface ChatRunDTO {
  id: number;
  board_id: number;
  user_message_id: number;
  status: "running" | "done" | "failed";
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export function listChatMessages(boardId: number) {
  return api<ChatMessageDTO[]>(`/api/boards/${boardId}/chat`);
}

export function sendChatMessage(
  boardId: number,
  message: string,
  mentions: string[],
  attachmentIds: number[] = [],
  mode: ChatMode = "create",
) {
  return api<ChatSendResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      board_id: boardId,
      message,
      mentions,
      attachment_ids: attachmentIds,
      mode,
    }),
  });
}

export function getActiveChatRun(boardId: number) {
  return api<ChatRunDTO | null>(`/api/boards/${boardId}/chat/runs/active`);
}

export interface ChatUploadResult {
  assets: Array<{ id: number; mime: string; url: string }>;
}

// Multipart upload for chat attachments. Uses raw fetch (not api())
// because api() pins Content-Type: application/json, which would break
// the multipart boundary the browser sets on FormData.
export async function uploadChatAttachments(
  boardId: number,
  files: File[],
): Promise<ChatUploadResult> {
  const form = new FormData();
  form.set("board_id", String(boardId));
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch("/api/chat/attachments", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `uploadChatAttachments: ${res.status}${detail ? ` ${detail}` : ""}`,
    );
  }
  return res.json() as Promise<ChatUploadResult>;
}

// ── Generation ───────────────────────────────────────────────────────────────

export interface BoardProject {
  flow_project_id: string;
  flow_account_id?: string | null;
  created: boolean;
}

export interface RequestDTO {
  id: number;
  node_id: number | null;
  type: string;
  params: Record<string, unknown>;
  // 'canceled' = user cancelled the request from the activity bell.
  // 'timeout' = backend's 5-minute video-gen budget elapsed; the row
  // self-transitions out of running. Both are terminal states.
  status: "queued" | "running" | "done" | "failed" | "canceled" | "timeout";
  result: Record<string, unknown>;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export function ensureBoardProject(boardId: number) {
  return api<BoardProject>(`/api/boards/${boardId}/project`, { method: "POST" });
}

export function getBoardProject(boardId: number) {
  return api<BoardProject>(`/api/boards/${boardId}/project`).catch(() => null);
}

// ── Auth / profile ───────────────────────────────────────────────────────

export interface AuthMe {
  // Identity rode on the Bearer token the extension sniffed off
  // aisandbox-pa. Since Flow moved to flow.google.com no Bearer is minted,
  // so these stay null and `identity_available` is false — genuinely
  // unavailable, not pending. Don't poll waiting for them.
  email: string | null;
  name: string | null;
  picture: string | null;
  verified_email: boolean | null;
  identity_available: boolean;
  // The tier generation will actually use. Same story as identity — it came
  // from /v1/credits with that token — so it is declared in the agent's
  // config now rather than discovered.
  paygate_tier: "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO" | null;
  // "extension" when a live signal was available (an older extension that
  // still captures a token), "configured" otherwise — the normal case.
  paygate_tier_source: "extension" | "configured" | "profile";
  // Set when the configured tier is not a value Flow recognises. Generation
  // will refuse until it is fixed, so surface it rather than waiting for a
  // dispatch to fail.
  paygate_tier_error: string | null;
  // Subscription SKU from /v1/credits — e.g. "WS_ULTRA" / "WS_PRO".
  // Available alongside paygate_tier; null until the credits fetch lands.
  sku: string | null;
  // Subscription credits remaining — bonus info from /v1/credits.
  // Frontend can display under the tier badge if desired.
  credits: number | null;
}

export function getAuthMe() {
  return api<AuthMe>("/api/auth/me").catch(() => null);
}

export interface AuthLogoutResult {
  ok: boolean;
  // Whether the agent could push a `logout` message to the extension
  // over its open WebSocket. False when no extension is connected —
  // agent-side caches were still cleared so the dashboard reflects
  // the logged-out state immediately.
  extension_notified: boolean;
}

export function logoutExtension() {
  return api<AuthLogoutResult>("/api/auth/logout", { method: "POST" });
}

export interface AuthScanResult {
  // True when the extension WebSocket is currently connected to the
  // agent. False means the user must install / enable / open Chrome.
  extension_connected: boolean;
  has_user_info: boolean;
  has_paygate_tier: boolean;
  // True when the agent had to ask the extension to re-fetch userinfo
  // (i.e. WS open but cache empty). Backend sets this only in that
  // narrow case; otherwise false.
  userinfo_nudged: boolean;
  // True when the agent successfully resolved tier from /v1/credits
  // during this scan call. False if the call failed (token expired,
  // network error, etc.) or if tier was already cached.
  tier_fetched: boolean;
}

export function scanExtension() {
  return api<AuthScanResult>("/api/auth/scan", { method: "POST" });
}

export async function createRequest(body: {
  type: string;
  flow_account_id?: string | null;
  node_id?: number;
  params: Record<string, unknown>;
}) {
  const response = await fetch("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await extractErrorMessage(response));
  return response.json() as Promise<RequestDTO>;
}

export function getRequest(id: number) {
  return api<RequestDTO>(`/api/requests/${id}`);
}

/**
 * One row of `GET /api/boards/{id}/requests`. Deliberately thinner than
 * `RequestDTO` — no `result` / `error`, because the caller is about to poll
 * each row anyway and shipping every finished result would make a board
 * load carry its whole generation history.
 *
 * `params` IS included: a page that reloaded mid-generation has to rebuild
 * the poll's options (prompt, aspect ratio) from it, since the
 * `dispatchGeneration` call that originally held them died with the old page.
 */
export interface BoardRequestItem {
  id: number;
  type: string;
  status: RequestDTO["status"];
  node_id: number | null;
  node_short_id: string | null;
  created_at: string;
  params: Record<string, unknown>;
}

/** The two families of in-flight request a reloading board can pick up.
 * They need different handling, so the caller names the ones it can
 * actually act on rather than filtering after the fact:
 * - `worker`: media-producing generations, driven by `attachPoll`.
 * - `sidecar`: the synchronous LLM activities (vision / auto-prompt),
 *   whose result is text and which `attachSidecarPoll` handles.
 * Backend rejects anything else — see `REQUEST_KINDS` in routes/boards.py. */
export type BoardRequestKind = "worker" | "sidecar";

/** Requests attached to this board's nodes. `active` narrows to the ones
 * still in flight (queued / running) — what a reloading board wants —
 * and `kinds` says which of those the caller can handle. Omitting
 * `kinds` gets `worker` only, which is the safe default: handing a
 * sidecar row to the generation poll is what wiped nodes' images. */
export function listBoardRequests(
  boardId: number,
  opts?: { active?: boolean; kinds?: BoardRequestKind[] },
) {
  const params = new URLSearchParams();
  if (opts?.active) params.set("active", "true");
  if (opts?.kinds && opts.kinds.length > 0) {
    params.set("kinds", opts.kinds.join(","));
  }
  const qs = params.toString();
  return api<{ items: BoardRequestItem[] }>(
    `/api/boards/${boardId}/requests${qs ? `?${qs}` : ""}`,
  );
}

// ── Plans + Pipeline runs ────────────────────────────────────────────────────

export interface PipelineRunDTO {
  id: number;
  plan_id: number;
  status: "pending" | "running" | "done" | "failed";
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export function getPlan(planId: number) {
  return api<PlanDTO>(`/api/plans/${planId}`);
}

export function runPlan(planId: number) {
  return api<PipelineRunDTO>(`/api/plans/${planId}/run`, { method: "POST" });
}

export function getPipelineRun(runId: number) {
  return api<PipelineRunDTO>(`/api/pipeline-runs/${runId}`);
}

// ── Media ────────────────────────────────────────────────────────────────────

export interface MediaStatus {
  available: boolean;
  has_url: boolean;
  mime?: string;
  reason?: string;
}

export function getMediaStatus(mediaId: string): Promise<MediaStatus> {
  const clean = mediaId.replace(/^media\//, "");
  return api<MediaStatus>(`/api/media/${encodeURIComponent(clean)}/status`);
}

export function mediaUrl(mediaId: string): string {
  const clean = mediaId.replace(/^media\//, "");
  return `/media/${encodeURIComponent(clean)}`;
}

// ── Upload ───────────────────────────────────────────────────────────────────

export interface UploadResponse {
  media_id: string;
  mime: string;
  size: number;
  // Detected by the agent from the image bytes; one of
  // IMAGE_ASPECT_RATIO_{SQUARE,PORTRAIT,LANDSCAPE}. Optional because legacy
  // responses (or formats we couldn't sniff) skip the field.
  aspect_ratio?: string;
  width?: number;
  height?: number;
}

export async function uploadImage(
  file: File,
  projectId: string,
  nodeId?: number,
  flowAccountId?: string | null,
): Promise<UploadResponse> {
  const form = new FormData();
  form.append("project_id", projectId);
  if (flowAccountId) form.append("flow_account_id", flowAccountId);
  if (nodeId !== undefined) form.append("node_id", String(nodeId));
  form.append("file", file);

  // Don't set Content-Type — the browser sets it with the correct boundary.
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<UploadResponse>;
}

export interface VisionDescribeResponse {
  media_id: string;
  description: string;
}

export interface AutoPromptResponse {
  node_id: number;
  prompt: string;
  safety_rewritten?: boolean;
  safety_notes?: string[];
}

export interface AutoPromptBatchResponse {
  node_id: number;
  prompts: string[];
  safety_rewritten?: boolean;
  safety_notes?: string[];
}

export async function autoPromptBatch(
  nodeId: number,
  count: number,
  opts?: { camera?: string; seedPrompt?: string; allowFallback?: boolean },
): Promise<AutoPromptBatchResponse> {
  const res = await fetch("/api/prompt/auto-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: nodeId,
      count,
      camera: opts?.camera,
      seed_prompt: opts?.seedPrompt,
      allow_fallback: opts?.allowFallback ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<AutoPromptBatchResponse>;
}

export async function autoPrompt(
  nodeId: number,
  opts?: {
    camera?: string;
    seedPrompt?: string;
    allowFallback?: boolean;
    durationSeconds?: number;
    silentVideo?: boolean;
  },
): Promise<AutoPromptResponse> {
  const res = await fetch("/api/prompt/auto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: nodeId,
      camera: opts?.camera,
      seed_prompt: opts?.seedPrompt,
      allow_fallback: opts?.allowFallback ?? false,
      duration_s: opts?.durationSeconds,
      silent_video: opts?.silentVideo ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<AutoPromptResponse>;
}

/** `nodeId` is optional on the wire but should always be passed from the
 * board: it is what lets the backend write `aiBrief` onto the node itself
 * (agent/flowboard/services/vision.py), so the brief survives a reload
 * that kills this promise, and it is what puts the activity row on a
 * board so `listBoardRequests` can find it again. */
export async function describeMedia(
  mediaId: string,
  nodeId?: number,
): Promise<VisionDescribeResponse> {
  const res = await fetch("/api/vision/describe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media_id: mediaId, node_id: nodeId }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<VisionDescribeResponse>;
}

export async function uploadImageFromUrl(
  url: string,
  projectId: string,
  nodeId?: number,
  flowAccountId?: string | null,
): Promise<UploadResponse> {
  const res = await fetch("/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, project_id: projectId, node_id: nodeId, flow_account_id: flowAccountId }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<UploadResponse>;
}


// ── LLM provider Settings ─────────────────────────────────────────────────
// Per-feature model: each of the 3 features (auto_prompt / vision /
// planner) independently pins a provider + model + effort. The old
// single-provider invariant ("all 3 features must point at the same
// name") is gone — `configured` now only means every feature has a
// provider pinned; model/effort stay optional.

export type LLMProviderName = "claude" | "gemini" | "openai" | "openai_api" | "muse";
export type LLMFeature = "auto_prompt" | "vision" | "planner" | "chat_agent";
export type LLMProviderMode = "cli" | "api" | "assistant" | "none";
export type LLMLastError =
  | "not_installed"
  | "not_authenticated"
  | "no_key"
  | "unreachable"
  | "unknown";

/** One entry of a provider's model catalog. `id` is what travels back
 * in the config / test payloads; `label` is display-only. */
export interface LLMModelInfo {
  id: string;
  label: string;
}

export interface LLMProviderInfo {
  name: LLMProviderName;
  supportsVision: boolean;
  available: boolean;
  configured: boolean;
  requiresKey: boolean;
  mode: LLMProviderMode;
  // Effort vocabularies differ per provider (claude: low…max, agy:
  // low/medium/high, codex: whatever it reports), so the UI must render
  // the options from `efforts` and never hardcode a list.
  supportsEffort: boolean;
  efforts: string[];
  // Legitimately [] when the catalog couldn't be fetched (offline, CLI
  // mid-upgrade, auth expired). The UI falls back to a free-text model
  // field in that case so a stale catalog can't block the user.
  models: LLMModelInfo[];
  defaultModel: string | null;
  baseUrl?: string | null;
  defaultBaseUrl?: string | null;
  lastError?: LLMLastError;
  lastTest?: { ok: boolean; latencyMs?: number; error?: string };
}

/** One feature's pin. Every field is independently nullable:
 * `provider` null = feature not set up yet; `model` / `effort` null =
 * "whatever the provider defaults to". */
export interface LLMFeatureConfig {
  provider: LLMProviderName | null;
  model: string | null;
  effort: string | null;
}

export interface LLMConfig {
  auto_prompt: LLMFeatureConfig;
  vision: LLMFeatureConfig;
  planner: LLMFeatureConfig;
  chat_agent: LLMFeatureConfig;
  // True once every feature has a provider. Drives the forced-setup
  // gate. A feature with a provider but no model still counts as
  // configured — the backend falls back to that provider's default.
  configured: boolean;
}

/** PUT body — feature keys and the fields inside them are all
 * optional, so a caller can patch one feature without re-sending the
 * other two. */
export type LLMConfigUpdate = Partial<
  Record<LLMFeature, Partial<LLMFeatureConfig>>
>;

export async function getLlmProviders(): Promise<LLMProviderInfo[]> {
  // Backend returns snake-case keys mapped from Python — but the route
  // already emits camelCase for the public surface. Re-typed here so
  // the spread/destructure pattern in the UI components stays clean.
  const res = await fetch("/api/llm/providers");
  if (!res.ok) throw new Error(`getLlmProviders: ${res.status}`);
  return res.json() as Promise<LLMProviderInfo[]>;
}

export interface LlmModelCatalog {
  models: LLMModelInfo[];
  /** True when the backend answered from its catalog cache rather than
   * re-asking the CLI — surfaced so the refresh button can tell the
   * user whether anything was actually re-fetched. */
  cached: boolean;
}

export async function getLlmProviderModels(
  name: LLMProviderName,
  force = false,
): Promise<LlmModelCatalog> {
  // `force=true` bypasses the backend's catalog cache. Wired to the
  // per-row refresh button for the case where the user installs a new
  // model / upgrades the CLI while the dialog is open.
  const qs = force ? "?force=true" : "";
  const res = await fetch(`/api/llm/providers/${name}/models${qs}`);
  if (!res.ok) throw new Error(`getLlmProviderModels: ${res.status}`);
  return res.json() as Promise<LlmModelCatalog>;
}

export async function getLlmConfig(): Promise<LLMConfig> {
  const res = await fetch("/api/llm/config");
  if (!res.ok) throw new Error(`getLlmConfig: ${res.status}`);
  return res.json() as Promise<LLMConfig>;
}

export async function setLlmConfig(
  partial: LLMConfigUpdate,
): Promise<{ ok: boolean }> {
  const res = await fetch("/api/llm/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

export async function setLlmProviderCredentials(
  name: LLMProviderName,
  body: { apiKey?: string | null; baseUrl?: string | null },
): Promise<{ ok: boolean }> {
  // Backend chmods secrets.json to 0o600 / private Windows ACL after every write;
  // keys are never echoed back via getLlmProviders.
  const res = await fetch(`/api/llm/providers/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

export async function setLlmApiKey(
  name: LLMProviderName,
  apiKey: string | null,
): Promise<{ ok: boolean }> {
  return setLlmProviderCredentials(name, { apiKey });
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export async function testLlmProvider(
  name: LLMProviderName,
  opts: { model?: string | null; effort?: string | null } = {},
): Promise<LlmTestResult> {
  // Cost-bounded by the backend: 1-token ping, 15s deadline. Returns
  // ok:false (NOT a non-200 HTTP status) on any failure mode so the
  // UI can render the error inline without try/catch boilerplate.
  //
  // model/effort are passed through so a per-feature row tests the
  // exact combination it is about to save — a provider that answers on
  // its default model can still fail on an exotic one.
  const body: { model?: string; effort?: string } = {};
  if (opts.model) body.model = opts.model;
  if (opts.effort) body.effort = opts.effort;
  const res = await fetch(`/api/llm/providers/${name}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  return res.json();
}


// ── Activity feed ─────────────────────────────────────────────────────────
// Read-only surface over the Request table. Captures every backend op:
// gen_image / gen_video / edit_image (worker), auto_prompt /
// auto_prompt_batch / vision / planner (LLM layer via record_activity).

export type ActivityType =
  | "auto_prompt" | "auto_prompt_batch"
  | "vision" | "planner"
  | "gen_image" | "gen_video" | "edit_image"
  | "upload" | "upload_url";
export type ActivityStatus = "queued" | "running" | "done" | "failed";

export interface ActivityListItem {
  id: number;
  type: ActivityType | string; // string fallback for forward-compat
  status: ActivityStatus | string;
  node_id: number | null;
  node_short_id: string | null;
  created_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface ActivityDetail extends ActivityListItem {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
}

export async function getActivityList(opts?: {
  limit?: number;
  beforeId?: number;
  type?: string[];
}): Promise<{ items: ActivityListItem[]; next_before_id: number | null }> {
  const search = new URLSearchParams();
  if (opts?.limit) search.set("limit", String(opts.limit));
  if (opts?.beforeId) search.set("before_id", String(opts.beforeId));
  if (opts?.type && opts.type.length > 0) search.set("type", opts.type.join(","));
  const q = search.toString();
  const res = await fetch(`/api/activity${q ? `?${q}` : ""}`);
  if (!res.ok) throw new Error(`getActivityList: ${res.status}`);
  return res.json();
}

export async function getActivityDetail(id: number): Promise<ActivityDetail> {
  const res = await fetch(`/api/activity/${id}`);
  if (!res.ok) throw new Error(`getActivityDetail: ${res.status}`);
  return res.json();
}

// Cancel a queued or running request. The activity row id IS the
// underlying Request.id, so the same numeric handle works against
// /api/requests. Backend returns 409 when the row has already settled
// (done/failed/timeout/canceled).
export async function cancelActivity(id: number): Promise<void> {
  const res = await fetch(`/api/requests/${id}/cancel`, { method: "POST" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`cancelActivity: ${res.status} ${detail}`);
  }
}


// ── References ───────────────────────────────────────────────────────────
// User-curated cross-board library of saved media. Backend mirror:
// agent/flowboard/routes/references.py + db.models.Reference.
// JSON wire format is snake_case (mirrors SQLModel column names);
// camelCase is reserved for the TS surface, so each helper maps the
// rows on the way back.

export interface ReferenceItem {
  id: number;
  mediaId: string;
  // Best-effort signed CDN URL captured at save time. May expire — the
  // canonical bytes live in storage/media/{mediaId}.{ext}; this field
  // exists purely as a re-ingest hint when the file goes missing.
  url: string | null;
  label: string;
  kind: "image" | "character" | "visual_asset" | "storyboard_shot" | "audio";
  // Snapshot of the source node's aiBrief at save time; lets cross-board
  // spawn skip the re-vision call entirely.
  aiBrief: string | null;
  aspectRatio: string | null;
  tags: string[];
  pinned: boolean;
  position: number;
  sourceBoardId: number | null;
  sourceNodeShortId: string | null;
  createdAt: string;
}

// Wire-shape POST body — snake_case to match the FastAPI schema 1:1.
export interface ReferenceCreateInput {
  media_id: string;
  kind: ReferenceItem["kind"];
  label?: string;
  ai_brief?: string | null;
  aspect_ratio?: string | null;
  url?: string | null;
  source_board_id?: number | null;
  source_node_short_id?: string | null;
  tags?: string[];
}

// Wire-shape PATCH body. Same snake_case convention.
export interface ReferencePatchInput {
  label?: string;
  pinned?: boolean;
  position?: number;
  tags?: string[];
}

interface ReferenceRowWire {
  id: number;
  media_id: string;
  url: string | null;
  label: string;
  kind: string;
  ai_brief: string | null;
  aspect_ratio: string | null;
  tags: string[] | null;
  pinned: boolean;
  position: number;
  source_board_id: number | null;
  source_node_short_id: string | null;
  created_at: string;
}

function mapReferenceRow(row: ReferenceRowWire): ReferenceItem {
  // Coerce the kind string into the typed union — the backend already
  // validates against _ALLOWED_KINDS so any unknown value here would
  // mean a backend bug. Fall back to "image" defensively rather than
  // throwing, so a single bad row doesn't break the whole list render.
  const allowed: ReferenceItem["kind"][] = [
    "image",
    "character",
    "visual_asset",
    "storyboard_shot",
    "audio",
  ];
  const kind: ReferenceItem["kind"] = (allowed as string[]).includes(row.kind)
    ? (row.kind as ReferenceItem["kind"])
    : "image";
  return {
    id: row.id,
    mediaId: row.media_id,
    url: row.url,
    label: row.label,
    kind,
    aiBrief: row.ai_brief,
    aspectRatio: row.aspect_ratio,
    tags: Array.isArray(row.tags) ? row.tags : [],
    pinned: row.pinned,
    position: row.position,
    sourceBoardId: row.source_board_id,
    sourceNodeShortId: row.source_node_short_id,
    createdAt: row.created_at,
  };
}

export async function listReferences(params?: {
  q?: string;
  pinned_first?: boolean;
  limit?: number;
}): Promise<ReferenceItem[]> {
  const search = new URLSearchParams();
  if (params?.q) search.set("q", params.q);
  if (params?.pinned_first !== undefined) {
    search.set("pinned_first", String(params.pinned_first));
  }
  if (params?.limit !== undefined) search.set("limit", String(params.limit));
  const qs = search.toString();
  const rows = await api<ReferenceRowWire[]>(
    `/api/references${qs ? `?${qs}` : ""}`,
  );
  return rows.map(mapReferenceRow);
}

export async function createReference(
  input: ReferenceCreateInput,
): Promise<ReferenceItem> {
  const row = await api<ReferenceRowWire>("/api/references", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return mapReferenceRow(row);
}

export async function patchReference(
  id: number,
  patch: ReferencePatchInput,
): Promise<ReferenceItem> {
  const row = await api<ReferenceRowWire>(`/api/references/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return mapReferenceRow(row);
}

export async function deleteReference(id: number): Promise<void> {
  // Backend returns 204 No Content; api<T>() would choke on the empty
  // body, so we use fetch() directly and skip the JSON parse.
  const res = await fetch(`/api/references/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`deleteReference: ${res.status} ${res.statusText}`);
  }
}

// ── Flow project sync (local → Flow, one direction) ───────────────────────

export interface BoardFlowStatus {
  board_id: number;
  board_name: string;
  flow_project_id: string | null;
  // null = could not be checked. Flow exposes no project-listing RPC since
  // the migration, so this is null in practice; treating null as `false`
  // would flag every board as missing from Flow.
  exists_on_flow: boolean | null;
}

export interface FlowListingStatus {
  available: boolean;
  reason: string | null;
  // The single Flow project every board generates into, when one is pinned.
  pinned_project_id: string | null;
}

export interface SyncStatusResponse {
  board_status: BoardFlowStatus[];
  flow_listing: FlowListingStatus;
}

export interface SyncUpAction {
  board_id: number;
  board_name: string;
  old_flow_project_id: string | null;
  new_flow_project_id: string | null;
  status: "created" | "rebound" | "failed";
  error: string | null;
}

export interface SyncUpResponse {
  synced: SyncUpAction[];
  failed: SyncUpAction[];
  total_boards: number;
}

export function getFlowSyncStatus(): Promise<SyncStatusResponse> {
  return api<SyncStatusResponse>("/api/flow/projects");
}

export async function syncBoardsUpToFlow(): Promise<SyncUpResponse> {
  const res = await fetch("/api/flow/projects/sync-up", { method: "POST" });
  if (!res.ok) {
    // The refusal body is {message, reason, fix, pinned_project_id}. `api()`
    // drops it entirely and extractErrorMessage keeps only `message` — but
    // `fix` is the half that says what to do about it, so join the two.
    const detail = await res
      .json()
      .then((b) => (b as { detail?: unknown } | null)?.detail)
      .catch(() => null);
    const d = (detail ?? {}) as { message?: unknown; fix?: unknown };
    const parts = [d.message, d.fix].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    throw new Error(
      parts.length > 0 ? parts.join(" ") : `${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<SyncUpResponse>;
}

// ── Pinned Flow project ───────────────────────────────────────────────────
// The single Flow project every board generates into. Flow dropped project
// creation and listing in the September 2026 migration, so this uuid is the
// only thing standing between a fresh install and "no project" on every
// dispatch. Server state — deliberately NOT mirrored into the persisted
// settings store.

/** Where the effective id comes from. `"override"` = saved from Settings
 * (wins), `"env"` = FLOWBOARD_FLOW_PROJECT_ID, `"none"` = nothing anywhere,
 * which is the state where generation cannot work at all. */
export type PinnedProjectSource = "override" | "env" | "none";

export interface PinnedFlowProject {
  /** The effective id. null when `source` is `"none"`. */
  flow_project_id: string | null;
  source: PinnedProjectSource;
  /** What .env pins, shown so the user can see what clearing falls back to. */
  env_project_id: string | null;
}

export interface PinnedFlowProjectUpdate extends PinnedFlowProject {
  /** Existing boards re-pointed at the new project by this write. */
  rebound_boards: number;
}

export function getPinnedFlowProject(): Promise<PinnedFlowProject> {
  return api<PinnedFlowProject>("/api/flow/projects/pinned");
}

/** `null` clears the override and falls back to .env. */
export async function setPinnedFlowProject(
  flowProjectId: string | null,
): Promise<PinnedFlowProjectUpdate> {
  const res = await fetch("/api/flow/projects/pinned", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flow_project_id: flowProjectId }),
  });
  if (!res.ok) {
    // The 400 `detail` already names exactly what is wrong with the uuid the
    // user typed, so it goes through verbatim — humanizeBackendError() would
    // only risk swapping an actionable sentence for a generic one.
    const body = await res.json().catch(() => null);
    const detail = (body as { detail?: unknown } | null)?.detail;
    throw new Error(
      typeof detail === "string" && detail
        ? detail
        : `${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<PinnedFlowProjectUpdate>;
}

export interface UpscaleMediaResponse {
  ok: boolean;
  media_id: string;
  resolution: string;
}

export async function upscaleMedia(
  mediaId: string,
  opts: {
    resolution: "2K" | "4K" | "1080p" | "4k";
    kind: "image" | "video";
    projectId?: string;
    aspectRatio?: string;
    nodeId?: number;
  },
): Promise<UpscaleMediaResponse> {
  const res = await fetch(`/api/media/${encodeURIComponent(mediaId)}/upscale`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resolution: opts.resolution,
      kind: opts.kind,
      project_id: opts.projectId,
      aspect_ratio: opts.aspectRatio,
      node_id: opts.nodeId,
    }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<UpscaleMediaResponse>;
}

export function shutdownService(opts?: {
  defer_process_exit?: boolean;
  stop_frontend?: boolean;
}): Promise<{ ok: boolean; shutting_down: boolean }> {
  return api<{ ok: boolean; shutting_down: boolean }>("/api/system/shutdown", {
    method: "POST",
    body: JSON.stringify(opts ?? {}),
  });
}

// ── .huabu Workflow Archive & Starter Recipes ───────────────────────────────

export interface RecipeNodeInput {
  key: string;
  type: NodeType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  status?: "idle" | "done";
  data: Record<string, unknown>;
}

export interface RecipeEdgeInput {
  source_key: string;
  target_key: string;
  source_variant_idx?: number | null;
}

export interface HuabuImportResponse {
  board: Board;
  nodes_count: number;
  edges_count: number;
  media_count: number;
}

export interface RecipeImportResponse {
  board: Board;
  nodes_count: number;
  edges_count: number;
  media_count: number;
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      // fall through
    }
  }
  const plainMatch = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (plainMatch && plainMatch[1]) {
    return plainMatch[1].trim();
  }
  return null;
}

export async function exportBoardHuabu(
  boardId: number,
  includeMedia = true,
  nodeIds?: number[],
): Promise<{ blob: Blob; filename: string }> {
  const qs = new URLSearchParams({
    include_media: includeMedia ? "true" : "false",
  });
  if (nodeIds && nodeIds.length > 0) {
    qs.set("node_ids", nodeIds.join(","));
  }
  const res = await fetch(
    `/api/boards/${boardId}/export.huabu?${qs.toString()}`,
  );
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  const blob = await res.blob();
  const filename =
    parseContentDispositionFilename(res.headers.get("content-disposition")) ?? "workflow.huabu";
  return { blob, filename };
}

export async function importBoardHuabu(
  file: File,
  targetBoardId?: number | null,
  appendToBoardId?: number | null,
): Promise<HuabuImportResponse> {
  const form = new FormData();
  form.append("file", file);
  const qs = new URLSearchParams();
  if (typeof targetBoardId === "number" && targetBoardId > 0) {
    qs.set("target_board_id", String(targetBoardId));
  }
  if (typeof appendToBoardId === "number" && appendToBoardId > 0) {
    qs.set("append_to_board_id", String(appendToBoardId));
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await fetch(`/api/boards/import-huabu${suffix}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<HuabuImportResponse>;
}

export function instantiateBoardRecipe(payload: {
  name: string;
  nodes: RecipeNodeInput[];
  edges: RecipeEdgeInput[];
  target_board_id?: number | null;
  append_to_board_id?: number | null;
}): Promise<RecipeImportResponse> {
  return api<RecipeImportResponse>("/api/boards/import-recipe", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface ScriptShotSpec {
  title: string;
  image_prompt: string;
  video_prompt: string;
  camera: string;
}

export interface ScriptBreakdownResponse {
  title: string;
  character_prompt: string;
  shots: ScriptShotSpec[];
  source: string;
}

export function breakdownScript(payload: {
  script: string;
  shot_count?: number;
  aspect_ratio?: string;
}): Promise<ScriptBreakdownResponse> {
  return api<ScriptBreakdownResponse>("/api/prompt/script-breakdown", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
