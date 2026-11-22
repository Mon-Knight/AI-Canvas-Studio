import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useBoardStore } from "../store/board";
import { displayNodeTitle } from "../constants/nodeLabels";
import { useChatStore } from "../store/chat";
import {
  getLlmConfig,
  type ChatMode,
  type LLMProviderInfo,
  type LLMProviderName,
  getLlmProviders,
  uploadChatAttachments,
  type ChatMessageDTO,
} from "../api/client";
import { pickImageFiles } from "../lib/filePicker";
import { AiProviderDialog } from "./AiProviderDialog";
import { useGenerationStore } from "../store/generation";
import "./ChatAnalysis.css";
import { IconAiWave } from "./JimengIcons";

// ── Limits (mirror backend caps in routes/chat.py) ────────────────────────────
const MAX_FILES = 5;
const UPLOAD_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const PROVIDER_NAMES: Record<LLMProviderName, string> = {
  claude: "Claude", openai: "OpenAI", openai_api: "OpenAI API", gemini: "Gemini", muse: "Muse",
};

function extractMentions(text: string): string[] {
  const matches = text.matchAll(/#(\w+)/g);
  return [...matches].map((m) => m[1]);
}

interface PickedFile {
  file: File;
  preview: string;
}

function MessageRow({ msg, onDraft }: { msg: ChatMessageDTO; onDraft(text: string): void }) {
  if (msg.role === "system") {
    return (
      <div className="chat-system-divider">
        <span>{msg.content}</span>
      </div>
    );
  }
  return (
    <div
      className={`chat-bubble ${
        msg.role === "user" ? "chat-bubble--user" : "chat-bubble--assistant"
      }`}
    >
      {msg.role === "assistant" && (
        <div className="chat-agent-label">AI 助手</div>
      )}
      {msg.attachments.length > 0 && (
        <div className="chat-dock__msg-attachments">
          {msg.attachments.map((a) => (
            <img
              key={a.id}
              className="chat-dock__msg-thumb"
              src={a.url}
              alt="附件预览"
              loading="lazy"
            />
          ))}
        </div>
      )}
      <div className="chat-bubble__text">{msg.content}</div>
      {msg.role === "assistant" && msg.content.trim() && (
        <button type="button" className="chat-action-link" onClick={() => onDraft(msg.content)}>用作视频提示词</button>
      )}
    </div>
  );
}

/**
 * 即梦风格右下角「与 AI 对话」胶囊按钮 + 右侧悬浮毛玻璃对话抽屉：
 * - 默认收纳为右下角小巧胶囊，零遮挡画布创作空间
 * - 点击展开右侧毛玻璃侧滑浮窗，支持 #节点 引用与参考图上传
 */
export function ChatDock() {
  const boardId = useBoardStore((s) => s.boardId);
  return boardId === null ? null : <BoardChat key={boardId} boardId={boardId} />;
}

function BoardChat({boardId}: {boardId: number}) {
  const nodes = useBoardStore((s) => s.nodes);
  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const loading = useChatStore((s) => s.loading);
  const activeRun = useChatStore((s) => s.activeRun);
  const runError = useChatStore((s) => s.runError);
  const loadChat = useChatStore((s) => s.loadChat);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const notifyError = useChatStore((s) => s.notifyError);

  // 默认收起为右下角「与 AI 对话」胶囊按钮，贴合即梦无遮挡体验
  const [collapsed, setCollapsed] = useState(true);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState<ChatMode>("analyze");
  const [provider, setProvider] = useState<LLMProviderInfo | null>(null);
  const [settingsMode, setSettingsMode] = useState<ChatMode | null>(null);
  const [modelName, setModelName] = useState("");
  const [analysisSupported, setAnalysisSupported] = useState(true);
  const [loadStatus, setLoadStatus] = useState<"loading" | "done" | "failed">("loading");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<{text:string; nodeId:string} | null>(null);
  const [placingDraft, setPlacingDraft] = useState(false);
  const placingRef = useRef(false);
  const videoNodes = nodes.filter((node) => node.data.type === "video");
  const providerReady = settingsMode === mode && loadStatus === "done" && !!(provider?.available && provider.configured);
  const maxFileMiB = provider?.name === "openai_api" || (provider?.name === "openai" && provider.mode === "api") ? 5 : 10;
  const oversizedImage = files.some(({ file }) => file.size > maxFileMiB * 1024 * 1024);
  const previewUrls = useRef(new Set<string>());

  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (boardId !== null) void loadChat(boardId);
  }, [boardId, loadChat]);

  useEffect(() => {
    if (collapsed) return;
    let alive = true;
    let seq = 0;
    const refresh = async () => {
      const turn = ++seq;
      try {
        const [providers, config] = await Promise.all([getLlmProviders(), getLlmConfig()]);
        if (!alive || turn !== seq) return;
        const pin = mode === "analyze"
          ? (config.chat_agent?.provider === "openai_api" ? config.chat_agent : null)
          : (config.chat_agent?.provider ? config.chat_agent : config.planner);
        const name = mode === "analyze" ? "openai_api" : pin?.provider ?? "muse";
        const resolved = providers.find((p) => p.name === name) ?? null;
        setProvider(resolved);
        setSettingsMode(mode);
        setAnalysisSupported(config.chat_agent != null);
        setModelName(pin?.model ?? resolved?.defaultModel ?? "");
        setLoadStatus("done");
      } catch {
        if (alive && turn === seq) setLoadStatus("failed");
      }
    };
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    window.addEventListener("flowboard:llm-config-changed", refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("flowboard:llm-config-changed", refresh);
    };
  }, [collapsed, mode]);

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeRun, runError, collapsed]);

  useEffect(() => {
    const urls = previewUrls.current;
    return () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  }, []);

  function prepareVideo(text: string) {
    const chosen = videoNodes.find((node) => node.selected) ?? (videoNodes.length === 1 ? videoNodes[0] : null);
    setDraft({ text, nodeId: chosen?.id ?? (videoNodes.length ? "" : "new") });
  }
  async function openVideoDraft() {
    if (placingRef.current || !draft?.text.trim() || draft.text.length > 500 || !draft.nodeId) return;
    const board = useBoardStore.getState();
    if (board.boardId !== boardId) return;
    placingRef.current = true;
    setPlacingDraft(true);
    try {
      let id: string | null = draft.nodeId;
      if (id === "new") {
        const anchor = board.nodes.find(n => n.selected) ?? board.nodes.at(-1);
        id = await board.addNodeOfType("video", anchor
          ? { x: anchor.position.x + (anchor.measured?.width ?? 260) + 64, y: anchor.position.y }
          : { x: 0, y: 0 });
      }
      if (useBoardStore.getState().boardId !== boardId) return;
      if (!id || !useBoardStore.getState().nodes.some(n => n.id === id && n.data.type === "video")) {
        notifyError("未能找到或创建视频节点，草稿已保留，请重试。");
        return;
      }
      useGenerationStore.getState().openGenerationDialog(id, draft.text.trim());
      setDraft(null);
      setCollapsed(true);
    } finally {
      placingRef.current = false;
      setPlacingDraft(false);
    }
  }

  const addFiles = useCallback(
    (list: File[] | FileList | null) => {
      if (!list || list.length === 0) return;
      const accepted: PickedFile[] = [];
      for (const f of Array.from(list)) {
        if (files.length + accepted.length >= MAX_FILES) {
          notifyError(`单条消息最多可添加 ${MAX_FILES} 张图片。`);
          break;
        }
        if (!UPLOAD_MIMES.includes(f.type)) {
          notifyError(`"${f.name}" 不是受支持的图片格式，请选择 JPG、PNG、WebP 或 GIF。`);
          continue;
        }
        if (f.size > maxFileMiB * 1024 * 1024) {
          notifyError(`"${f.name}" 超过当前模型的 ${maxFileMiB} MiB 单图限制。`);
          continue;
        }
        const preview = URL.createObjectURL(f);
        previewUrls.current.add(preview);
        accepted.push({ file: f, preview });
      }
      if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
    },
    [files, notifyError, maxFileMiB],
  );

  const removeFile = useCallback((preview: string) => {
    setFiles((prev) => {
      const next = prev.filter((f) => f.preview !== preview);
      const removed = prev.find((f) => f.preview === preview);
      if (removed) { URL.revokeObjectURL(removed.preview); previewUrls.current.delete(removed.preview); }
      return next;
    });
  }, []);

  const canSend =
    !pending && !loading &&
    !uploading &&
    activeRun === null &&
    providerReady && (mode !== "analyze" || analysisSupported) &&
    !oversizedImage && (files.length === 0 || provider?.supportsVision === true) &&
    (text.trim().length > 0 || files.length > 0);

  const handleSend = useCallback(async () => {
    if (!canSend || boardId === null) return;
    const known = new Set(nodes.map((n) => n.data.shortId));
    const mentions = [...new Set(extractMentions(text).filter((m) => known.has(m)))];
    if (mentions.length > 32) { notifyError("单条消息最多引用 32 个不同节点。"); return; }

    let attachmentIds: number[] = [];
    let previews: Array<{ mime: string; url: string }> = [];
    if (files.length > 0) {
      setUploading(true);
      try {
        const result = await uploadChatAttachments(boardId, files.map((f) => f.file));
        attachmentIds = result.assets.map((a) => a.id);
        previews = result.assets.map((a) => ({ mime: a.mime, url: a.url }));
      } catch (err) {
        notifyError(err instanceof Error ? err.message : String(err));
        setUploading(false);
        return;
      }
      setUploading(false);
      if (useBoardStore.getState().boardId !== boardId) return;
    }

    const content =
      text.trim() || (mode === "analyze" ? "请分析这些参考图的构图、光线与运镜，并给出视频提示词建议。" : "请结合参考图规划并创建画面与视频节点。");
    await sendMessage(content, mentions, attachmentIds, previews, mode);
    if (useBoardStore.getState().boardId !== boardId || useChatStore.getState().error) return;
    setText("");
    for (const f of files) { URL.revokeObjectURL(f.preview); previewUrls.current.delete(f.preview); }
    setFiles([]);
  }, [canSend, boardId, nodes, text, files, mode, sendMessage, notifyError]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );


  if (collapsed) {
    return (
      <button
        type="button"
        className="jm-ai-pill"
        onClick={() => {
          setCollapsed(false);
          requestAnimationFrame(() => textareaRef.current?.focus());
        }}
        aria-label="打开与 AI 对话面板"
      >
        <IconAiWave size={16} />
        <span className="jm-ai-pill__label">与 AI 对话</span>
        {activeRun && <span className="jm-ai-pill__running" aria-hidden="true" />}
      </button>
    );
  }

  return (<>
    <aside className="jm-chat-drawer" aria-label="与 AI 对话">
      <div className="chat-dock__header">
        <IconAiWave size={16} />
        <span className="chat-dock__title">与 AI 对话</span>
        <button type="button" className="chat-model-link" onClick={() => setSettingsOpen(true)}
          title={modelName && settingsMode === mode ? `当前模型：${modelName}，点击配置` : "配置对话模型和 API 密钥"}>
          {mode === "analyze" ? "OpenAI API" : provider && settingsMode === mode ? PROVIDER_NAMES[provider.name] : "模型设置"} <span aria-hidden="true">⌄</span>
        </button>
        <button
          type="button"
          className="chat-dock__collapse-btn"
          onClick={() => setCollapsed(true)}
          aria-label="收起对话面板"
          title="收起"
        >
          ✕
        </button>
      </div>

      <div className="chat-modes" role="group" aria-label="对话模式">
        {(["analyze", "create"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={mode === value} disabled={pending || uploading || !!activeRun}
            onClick={() => setMode(value)}>{value === "analyze" ? "创意分析" : "创作编排"}</button>
        ))}
      </div>
      {loadStatus === "done" && mode === "analyze" && !analysisSupported && (
        <p className="chat-dock__notice" role="status">当前本地服务版本尚未支持只读分析，请更新并重启 Agent 后再发送。</p>
      )}
      {!providerReady && (
        <div className="chat-dock__notice" role="status">
          {loadStatus === "failed" ? "读取模型配置失败，请检查本地服务。" : loadStatus === "loading" || settingsMode !== mode ? "正在读取对话模型…" : mode === "analyze" ? "创意分析使用外部 OpenAI API，请先保存密钥。此密钥不用于视频生成。" : "编排模型尚未就绪，请在模型设置中选择提供商。"}
          {loadStatus !== "loading" && <button type="button" className="chat-action-link" onClick={() => setSettingsOpen(true)}>{mode === "analyze" ? "配置分析密钥" : "配置模型"}</button>}
        </div>
      )}

      <div className="chat-dock__messages" ref={messagesRef}>
        {messages.length === 0 && !activeRun && (
          <div className="jm-chat-empty">
            <p className="jm-chat-empty__title">{mode === "analyze" ? "先拆解镜头，再决定怎么拍" : "让分镜落到画布上"}</p>
            <p className="jm-chat-empty__desc">
              {mode === "analyze" ? "上传参考图或输入 #节点编号，讨论构图、运镜和节奏。分析只返回建议。" : "描述创作目标，助手可创建或修改节点，并按指令提交生成任务。"}
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageRow key={msg.id} msg={msg} onDraft={prepareVideo} />
        ))}
        {activeRun && (
          <div className="chat-dock__step">
            <span className="chat-dock__step-dots" aria-hidden="true">●●●</span>
            <span>模型正在处理，请稍候…</span>
          </div>
        )}
        {runError && (
          <div className="chat-dock__error">执行出错：{runError}</div>
        )}
      </div>

      {draft && (
        <section className="chat-video-draft" aria-label="视频提示词草稿">
          <strong>视频提示词草稿</strong>
          <select aria-label="目标视频节点" value={draft.nodeId} disabled={placingDraft} onChange={(e) => setDraft({...draft, nodeId: e.target.value})}>
            <option value="">选择目标视频节点</option>
            <option value="new">新建视频节点</option>
            {videoNodes.map((node) => <option key={node.id} value={node.id}>#{node.data.shortId} · {displayNodeTitle(node.data.title, node.data.type)}</option>)}
          </select>
          <textarea aria-label="编辑视频提示词" value={draft.text} rows={3} disabled={placingDraft} onChange={(e) => setDraft({...draft, text:e.target.value})} />
          <small>{draft.text.length}/500 · {draft.text.length > 500 ? "请精简内容再使用，原文已完整保留。" : "只把草稿填入节点；点击生成后才会使用 Flow 账号提交。"}</small>
          <div><button type="button" className="chat-action-link" disabled={placingDraft} onClick={() => setDraft(null)}>取消</button>
            <button type="button" className="chat-action-link" disabled={placingDraft || !draft.text.trim() || draft.text.length > 500 || (draft.nodeId !== "new" && !videoNodes.some((n) => n.id === draft.nodeId))} onClick={() => void openVideoDraft()}>{placingDraft ? "正在定位…" : draft.nodeId === "new" ? "新建节点并填入" : "填入视频节点"}</button></div>
        </section>
      )}
      <div className="chat-dock__composer">
        <p className="chat-data-hint">{mode === "analyze" ? "仅分析，不修改画布。" : "编排可能修改画布并消耗生成额度。"} 对话、画布摘要和参考图将发给所选模型。</p>
        {oversizedImage && <p className="chat-dock__notice" role="status">当前模型的单图上限为 {maxFileMiB} MiB，请移除超限图片后再发送。</p>}
        {files.length > 0 && provider && !provider.supportsVision && <p className="chat-dock__notice">该模型服务不支持图片，请移除参考图或切换提供商。</p>}
        {files.length > 0 && (
          <div className="chat-dock__attach-strip">
            {files.map((f) => (
              <div key={f.preview} className="chat-dock__thumb">
                <img src={f.preview} alt={f.file.name} />
                <button
                  type="button"
                  className="chat-dock__thumb-remove"
                  onClick={() => removeFile(f.preview)}
                  aria-label={`移除 ${f.file.name}`}
                >
                  ×
                </button>
              </div>
            ))}
            <span className="chat-dock__attach-count">
              {files.length}/{MAX_FILES}
            </span>
          </div>
        )}
        <div className="chat-dock__input-row">
          <button
            type="button"
            className="chat-dock__attach-btn"
            onClick={() => {
              void pickImageFiles({
                multiple: true,
                accept: UPLOAD_MIMES.join(","),
                title: "选择参考图片",
              })
                .then((picked) => addFiles(picked))
                .catch((err) => notifyError(err instanceof Error ? err.message : "选择图片失败"));
            }}
            disabled={pending || uploading || activeRun !== null || provider?.supportsVision === false}
            title={`最多 5 张参考图，每张不超过 ${maxFileMiB} MiB`}
            aria-label="上传参考图片"
          >
            ＋
          </button>
          <textarea
            ref={textareaRef}
            className="chat-dock__textarea"
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              activeRun
                ? "AI 正在执行画布任务…"
                : mode === "analyze" ? "想分析哪个镜头？可引用 #节点编号…" : "描述希望助手执行的创作任务…"
            }
            disabled={pending || uploading || activeRun !== null}
            rows={2}
          />
          <button
            type="button"
            className="chat-dock__send"
            onClick={() => void handleSend()}
            disabled={!canSend}
            aria-label="发送消息"
            title="发送"
          >
            {uploading ? "…" : "↑"}
          </button>
        </div>
      </div>
    </aside>
    <AiProviderDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </>);
}
