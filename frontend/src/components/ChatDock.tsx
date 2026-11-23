import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useReactFlow } from "@xyflow/react";
import { useBoardStore, type FlowNode } from "../store/board";
import { displayNodeTitle } from "../constants/nodeLabels";
import { useChatStore } from "../store/chat";
import {
  getLlmConfig,
  getLlmProviders,
  mediaUrl,
  patchNode,
  uploadChatAttachments,
  type ChatMessageDTO,
  type ChatMode,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../api/client";
import {
  MAX_CHAT_MENTIONS,
  buildDefaultNodeChatMessage,
  mergeChatMentions,
  resolveActiveCanvasReferences,
  resolveNodePrimaryMedia,
} from "../lib/chatReferences";
import { pickImageFiles } from "../lib/filePicker";
import { AiProviderDialog } from "./AiProviderDialog";
import { useGenerationStore } from "../store/generation";
import { filterDirectorSkills, type DirectorSkillEntry } from "../constants/directorSkills";
import "./ChatAnalysis.css";
import { IconAiWave } from "./JimengIcons";

// ── Limits (mirror backend caps in routes/chat.py) ────────────────────────────
const MAX_FILES = 5;
const UPLOAD_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const PROVIDER_NAMES: Record<LLMProviderName, string> = {
  claude: "Claude",
  openai: "OpenAI",
  openai_api: "OpenAI API",
  gemini: "Gemini",
  muse: "Muse",
};

const NODE_TYPE_GLYPH: Record<string, string> = {
  prompt: "✦",
  note: "✎",
  character: "◎",
  image: "▣",
  video: "▶",
  visual_asset: "❖",
  Storyboard: "⊞",
  merge: "⧉",
};

const ANALYZE_QUICK_STARTERS = [
  { label: "拆解构图与画风", prompt: "请拆解所选画布节点的构图、光影与美术画风亮点。" },
  { label: "提炼主体设定词", prompt: "请基于所选节点提炼一份高还原度的主体设定提示词（保留画风与服饰特征）。" },
  { label: "推导视频运镜", prompt: "请基于所选画面设计一段 8 秒图生视频的镜头运动与动作提示词。" },
] as const;

const CREATE_QUICK_STARTERS = [
  { label: "延展下一镜画面", prompt: "请结合所选画布节点的角色与风格，创建并连线下一个连续分镜图片节点。" },
  { label: "生成视频运镜草稿", prompt: "请为所选画布节点准备一个下游视频节点并填入贴合画面的运镜提示词草稿。" },
] as const;

interface PickedFile {
  file: File;
  preview: string;
}

function NodeThumbBadge({ node }: { node: FlowNode }) {
  const primary = resolveNodePrimaryMedia(node);
  if (!primary) {
    return (
      <span className="chat-node-ref__glyph" aria-hidden="true">
        {NODE_TYPE_GLYPH[node.data.type] ?? "◈"}
      </span>
    );
  }
  if (primary.isVideo) {
    return (
      <video
        className="chat-node-ref__thumb"
        src={mediaUrl(primary.mediaId)}
        muted
        playsInline
        preload="metadata"
      />
    );
  }
  return (
    <img
      className="chat-node-ref__thumb"
      src={mediaUrl(primary.mediaId)}
      alt={displayNodeTitle(node.data.title, node.data.type)}
      loading="lazy"
    />
  );
}

function MessageRow({
  msg,
  nodesByShortId,
  selectedApplyTarget,
  onFocusNode,
  onDraftVideo,
  onApplyToSelectedNode,
}: {
  msg: ChatMessageDTO;
  nodesByShortId: ReadonlyMap<string, FlowNode>;
  selectedApplyTarget: FlowNode | null;
  onFocusNode(shortId: string): void;
  onDraftVideo(text: string): void;
  onApplyToSelectedNode(node: FlowNode, text: string): void;
}) {
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
      {msg.mentions.length > 0 && (
        <div className="chat-msg-mentions" aria-label="引用的画布节点">
          {msg.mentions.map((sid) => {
            const target = nodesByShortId.get(sid);
            const label = target
              ? `${displayNodeTitle(target.data.title, target.data.type)} #${sid}`
              : `#${sid}`;
            return (
              <button
                key={sid}
                type="button"
                className="chat-msg-mention-pill"
                onClick={() => onFocusNode(sid)}
                disabled={!target}
                title={target ? `点击在画布定位 ${label}` : `节点 #${sid}`}
              >
                {target && <NodeThumbBadge node={target} />}
                <span>{label}</span>
              </button>
            );
          })}
        </div>
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
        <div className="chat-bubble__actions">
          {selectedApplyTarget && (
            <button
              type="button"
              className="chat-action-link"
              onClick={() => onApplyToSelectedNode(selectedApplyTarget, msg.content)}
              title={`将此回复直接填入当前选中的节点 #${selectedApplyTarget.data.shortId}`}
            >
              填入选中节点 (#{selectedApplyTarget.data.shortId})
            </button>
          )}
          <button
            type="button"
            className="chat-action-link"
            onClick={() => onDraftVideo(msg.content)}
          >
            用作视频提示词
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 即梦风格右下角「与 AI 对话」胶囊按钮 + 右侧悬浮毛玻璃对话抽屉：
 * - 默认收纳为右下角小巧胶囊，零遮挡画布创作空间（选中画布节点时实时提示可引用数量）
 * - 展开后自动联动当前画布选中节点生成「画布引用」胶囊，支持一键定位、增删引用与提示词双向回填
 */
export function ChatDock() {
  const boardId = useBoardStore((s) => s.boardId);
  return boardId === null ? null : <BoardChat key={boardId} boardId={boardId} />;
}

function BoardChat({ boardId }: { boardId: number }) {
  const { fitView } = useReactFlow();
  const nodes = useBoardStore((s) => s.nodes);
  const setNodes = useBoardStore((s) => s.setNodes);
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
  const [draft, setDraft] = useState<{ text: string; nodeId: string } | null>(null);
  const [placingDraft, setPlacingDraft] = useState(false);
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null);

  // 画布选中联动状态：默认自动引用当前画布选中的节点；点 × 可临时忽略，或通过「+ 引用节点」手动增补固定引用
  const [mutedSelectedIds, setMutedSelectedIds] = useState<Set<string>>(() => new Set());
  const [pinnedNodeIds, setPinnedNodeIds] = useState<string[]>([]);
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  const [nodeFilterQuery, setNodeFilterQuery] = useState("");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);

  const placingRef = useRef(false);
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  const videoNodes = nodes.filter((node) => node.data.type === "video");
  const selectedCanvasNodes = useMemo(
    () => nodes.filter((node) => node.selected),
    [nodes],
  );
  const selectedIdsSig = selectedCanvasNodes.map((n) => n.id).join(",");

  // 当某个节点在画布取消选中后，自动从忽略集合移除，确保下次在画布重新点选它时能立即恢复自动引用
  useEffect(() => {
    setMutedSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const selectedSet = new Set(selectedCanvasNodes.map((n) => n.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (selectedSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectedIdsSig, selectedCanvasNodes]);

  // 清理已被删除节点的固定引用
  useEffect(() => {
    setPinnedNodeIds((prev) => {
      if (prev.length === 0) return prev;
      const existing = new Set(nodes.map((n) => n.id));
      const filtered = prev.filter((id) => existing.has(id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [nodes]);

  // 点击外部关闭节点选择浮层
  useEffect(() => {
    if (!nodePickerOpen) return;
    const onOutside = (e: Event) => {
      const target = e.target as Node | null;
      const el = target instanceof Element ? target : target?.parentElement ?? null;
      if (el && pickerWrapRef.current?.contains(el)) return;
      setNodePickerOpen(false);
    };
    document.addEventListener("pointerdown", onOutside, true);
    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [nodePickerOpen]);

  const activeCanvasRefs = useMemo(
    () => resolveActiveCanvasReferences(nodes, mutedSelectedIds, pinnedNodeIds),
    [nodes, mutedSelectedIds, pinnedNodeIds],
  );

  const nodesByShortId = useMemo(() => {
    const map = new Map<string, FlowNode>();
    for (const n of nodes) {
      map.set(n.data.shortId, n);
    }
    return map;
  }, [nodes]);

  // 当前在画布单选的可回填非视频节点（图片 / 主体 / 故事板 / 文本 / 便签）
  const selectedApplyTarget = useMemo(() => {
    if (selectedCanvasNodes.length !== 1) return null;
    const target = selectedCanvasNodes[0];
    if (
      ["image", "character", "Storyboard", "prompt", "note"].includes(
        target.data.type,
      )
    ) {
      return target;
    }
    return null;
  }, [selectedCanvasNodes]);

  const mutedSelectedCount = useMemo(
    () => selectedCanvasNodes.filter((n) => mutedSelectedIds.has(n.id)).length,
    [selectedCanvasNodes, mutedSelectedIds],
  );

  const pickerCandidates = useMemo(() => {
    const q = nodeFilterQuery.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n) => {
      const title = displayNodeTitle(n.data.title, n.data.type).toLowerCase();
      const sid = n.data.shortId.toLowerCase();
      const promptSnippet = (n.data.prompt ?? n.data.aiBrief ?? "").toLowerCase();
      return title.includes(q) || sid.includes(q) || promptSnippet.includes(q);
    });
  }, [nodes, nodeFilterQuery]);

  const providerReady =
    settingsMode === mode &&
    loadStatus === "done" &&
    !!(provider?.available && provider.configured);
  const maxFileMiB =
    provider?.name === "openai_api" ||
    (provider?.name === "openai" && provider.mode === "api")
      ? 5
      : 10;
  const oversizedImage = files.some(
    ({ file }) => file.size > maxFileMiB * 1024 * 1024,
  );
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
        const [providers, config] = await Promise.all([
          getLlmProviders(),
          getLlmConfig(),
        ]);
        if (!alive || turn !== seq) return;
        const pin =
          mode === "analyze"
            ? config.chat_agent?.provider === "openai_api"
              ? config.chat_agent
              : null
            : config.chat_agent?.provider
              ? config.chat_agent
              : config.planner;
        const name = mode === "analyze" ? "openai_api" : (pin?.provider ?? "muse");
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
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
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
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const focusNodeOnCanvas = useCallback(
    (shortId: string) => {
      const target = nodesByShortId.get(shortId);
      if (!target) return;
      setNodes(
        useBoardStore.getState().nodes.map((n) => ({
          ...n,
          selected: n.id === target.id,
        })),
      );
      void fitView({
        nodes: [{ id: target.id }],
        duration: 240,
        padding: 0.5,
        maxZoom: 1,
      });
    },
    [nodesByShortId, setNodes, fitView],
  );

  const handleDismissCanvasRef = useCallback(
    (rfId: string, source: "selected" | "pinned") => {
      if (source === "selected") {
        setMutedSelectedIds((prev) => {
          const next = new Set(prev);
          next.add(rfId);
          return next;
        });
      }
      setPinnedNodeIds((prev) => prev.filter((id) => id !== rfId));
    },
    [],
  );

  const handleTogglePickerNode = useCallback(
    (node: FlowNode) => {
      const activeEntry = activeCanvasRefs.find((r) => r.node.id === node.id);
      if (activeEntry) {
        handleDismissCanvasRef(node.id, activeEntry.source);
        return;
      }
      if (node.selected && mutedSelectedIds.has(node.id)) {
        setMutedSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(node.id);
          return next;
        });
        return;
      }
      setPinnedNodeIds((prev) =>
        prev.includes(node.id) ? prev : [...prev, node.id].slice(0, MAX_CHAT_MENTIONS),
      );
    },
    [activeCanvasRefs, mutedSelectedIds, handleDismissCanvasRef],
  );

  const handleApplyToSelectedNode = useCallback(
    (target: FlowNode, rawContent: string) => {
      const clipped = rawContent.trim().slice(0, 2000);
      if (!clipped) return;
      const dbId = parseInt(target.id, 10);
      if (target.data.type === "Storyboard") {
        useBoardStore.getState().updateNodeData(target.id, { aiBrief: clipped });
        if (!isNaN(dbId)) {
          patchNode(dbId, { data: { aiBrief: clipped } }).catch(() => {});
        }
      } else {
        const nextStatus =
          target.data.type === "prompt" ? "done" : target.data.status;
        useBoardStore.getState().updateNodeData(target.id, {
          prompt: clipped,
          ...(nextStatus ? { status: nextStatus } : {}),
        });
        if (!isNaN(dbId)) {
          patchNode(dbId, {
            ...(target.data.type === "prompt" ? { status: "done" } : {}),
            data: { prompt: clipped },
          }).catch(() => {});
        }
        // 若节点尚未落盘媒体且非纯文本/便签，同时展开生成对话框或保持内联控制栏同步
        if (!["prompt", "note"].includes(target.data.type)) {
          useGenerationStore.getState().openGenerationDialog(target.id, clipped);
        }
      }
      setAppliedNotice(`已填入节点 #${target.data.shortId}`);
      window.setTimeout(() => setAppliedNotice(null), 2400);
    },
    [],
  );

  function prepareVideo(content: string) {
    const chosen =
      videoNodes.find((node) => node.selected) ??
      (videoNodes.length === 1 ? videoNodes[0] : null);
    setDraft({ text: content, nodeId: chosen?.id ?? (videoNodes.length ? "" : "new") });
  }

  async function openVideoDraft() {
    if (
      placingRef.current ||
      !draft?.text.trim() ||
      draft.text.length > 500 ||
      !draft.nodeId
    ) {
      return;
    }
    const board = useBoardStore.getState();
    if (board.boardId !== boardId) return;
    placingRef.current = true;
    setPlacingDraft(true);
    try {
      let id: string | null = draft.nodeId;
      if (id === "new") {
        const anchor =
          board.nodes.find((n) => n.selected) ?? board.nodes.at(-1);
        id = await board.addNodeOfType(
          "video",
          anchor
            ? {
                x: anchor.position.x + (anchor.measured?.width ?? 260) + 64,
                y: anchor.position.y,
              }
            : { x: 0, y: 0 },
        );
      }
      if (useBoardStore.getState().boardId !== boardId) return;
      if (
        !id ||
        !useBoardStore
          .getState()
          .nodes.some((n) => n.id === id && n.data.type === "video")
      ) {
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
          notifyError(
            `"${f.name}" 不是受支持的图片格式，请选择 JPG、PNG、WebP 或 GIF。`,
          );
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
      if (removed) {
        URL.revokeObjectURL(removed.preview);
        previewUrls.current.delete(removed.preview);
      }
      return next;
    });
  }, []);

  const canSend =
    !pending &&
    !loading &&
    !uploading &&
    activeRun === null &&
    providerReady &&
    (mode !== "analyze" || analysisSupported) &&
    !oversizedImage &&
    (files.length === 0 || provider?.supportsVision === true) &&
    (text.trim().length > 0 || files.length > 0 || activeCanvasRefs.length > 0);

  const handleSend = useCallback(async () => {
    if (!canSend || boardId === null) return;
    const mentions = mergeChatMentions(text, activeCanvasRefs, nodes);
    if (mentions.length > MAX_CHAT_MENTIONS) {
      notifyError(`单条消息最多引用 ${MAX_CHAT_MENTIONS} 个不同节点。`);
      return;
    }

    let attachmentIds: number[] = [];
    let previews: Array<{ mime: string; url: string }> = [];
    if (files.length > 0) {
      setUploading(true);
      try {
        const result = await uploadChatAttachments(
          boardId,
          files.map((f) => f.file),
        );
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
      text.trim() ||
      buildDefaultNodeChatMessage(
        mode,
        activeCanvasRefs.map((r) => r.node.data.shortId),
      );
    await sendMessage(content, mentions, attachmentIds, previews, mode);
    if (useBoardStore.getState().boardId !== boardId || useChatStore.getState().error) {
      return;
    }
    setText("");
    setPinnedNodeIds([]);
    setNodePickerOpen(false);
    for (const f of files) {
      URL.revokeObjectURL(f.preview);
      previewUrls.current.delete(f.preview);
    }
    setFiles([]);
  }, [canSend, boardId, activeCanvasRefs, nodes, text, files, mode, sendMessage, notifyError]);

  const slashSkills = useMemo(() => {
    if (!slashMenuOpen && !text.startsWith("/")) return [];
    const query = text.startsWith("/") ? text.slice(1) : "";
    return filterDirectorSkills(query);
  }, [slashMenuOpen, text]);

  function handleSelectDirectorSkill(skill: DirectorSkillEntry) {
    setSlashMenuOpen(false);
    if (skill.action.kind === "open_director_stage") {
      setText("");
      window.dispatchEvent(
        new CustomEvent("flowboard:open-director-stage", {
          detail: { tab: skill.action.tab },
        }),
      );
      return;
    }
    setText(skill.action.preferredChatPrompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape" && (nodePickerOpen || slashMenuOpen)) {
        e.preventDefault();
        setNodePickerOpen(false);
        setSlashMenuOpen(false);
        return;
      }
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.nativeEvent.isComposing &&
        e.nativeEvent.keyCode !== 229
      ) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend, nodePickerOpen, slashMenuOpen],
  );

  if (collapsed) {
    const selectedBadge =
      selectedCanvasNodes.length === 1
        ? `#${selectedCanvasNodes[0].data.shortId}`
        : selectedCanvasNodes.length > 1
          ? `已选 ${selectedCanvasNodes.length}`
          : null;
    return (
      <button
        type="button"
        className="jm-ai-pill"
        onClick={() => {
          setCollapsed(false);
          requestAnimationFrame(() => textareaRef.current?.focus());
        }}
        aria-label="打开与 AI 对话面板"
        title={
          selectedBadge
            ? `打开与 AI 对话（将自动引用画布选中节点 ${selectedBadge}）`
            : "打开与 AI 对话面板"
        }
      >
        <IconAiWave size={16} />
        <span className="jm-ai-pill__label">与 AI 对话</span>
        {selectedBadge && (
          <span className="jm-ai-pill__ref-badge">{selectedBadge}</span>
        )}
        {activeRun && <span className="jm-ai-pill__running" aria-hidden="true" />}
      </button>
    );
  }

  const quickStarters =
    mode === "analyze" ? ANALYZE_QUICK_STARTERS : CREATE_QUICK_STARTERS;

  return (
    <>
      <aside className="jm-chat-drawer" aria-label="与 AI 对话">
        <div className="chat-dock__header">
          <IconAiWave size={16} />
          <span className="chat-dock__title">与 AI 对话</span>
          <button
            type="button"
            className="chat-model-link"
            onClick={() => setSettingsOpen(true)}
            title={
              modelName && settingsMode === mode
                ? `当前模型：${modelName}，点击配置`
                : "配置对话模型和 API 密钥"
            }
          >
            {mode === "analyze"
              ? "OpenAI API"
              : provider && settingsMode === mode
                ? PROVIDER_NAMES[provider.name]
                : "模型设置"}{" "}
            <span aria-hidden="true">⌄</span>
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
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={pending || uploading || !!activeRun}
              onClick={() => setMode(value)}
            >
              {value === "analyze" ? "创意分析" : "创作编排"}
            </button>
          ))}
        </div>
        {loadStatus === "done" && mode === "analyze" && !analysisSupported && (
          <p className="chat-dock__notice" role="status">
            当前本地服务版本尚未支持只读分析，请更新并重启 Agent 后再发送。
          </p>
        )}
        {!providerReady && (
          <div className="chat-dock__notice" role="status">
            {loadStatus === "failed"
              ? "读取模型配置失败，请检查本地服务。"
              : loadStatus === "loading" || settingsMode !== mode
                ? "正在读取对话模型…"
                : mode === "analyze"
                  ? "创意分析使用外部 OpenAI API，请先保存密钥。此密钥不用于视频生成。"
                  : "编排模型尚未就绪，请在模型设置中选择提供商。"}
            {loadStatus !== "loading" && (
              <button
                type="button"
                className="chat-action-link"
                onClick={() => setSettingsOpen(true)}
              >
                {mode === "analyze" ? "配置分析密钥" : "配置模型"}
              </button>
            )}
          </div>
        )}
        {appliedNotice && (
          <div className="chat-applied-toast" role="status">
            ✓ {appliedNotice}
          </div>
        )}

        <div className="chat-dock__messages" ref={messagesRef}>
          {messages.length === 0 && !activeRun && (
            <div className="jm-chat-empty">
              <p className="jm-chat-empty__title">
                {mode === "analyze" ? "先拆解镜头，再决定怎么拍" : "让分镜落到画布上"}
              </p>
              <p className="jm-chat-empty__desc">
                {mode === "analyze"
                  ? "直接在画布点击节点即可自动引用（也可点「+ 引用节点」或上传参考图），讨论构图、画风与运镜建议。"
                  : "直接选中画布节点自动带入上下文，描述创作目标，助手可续写分镜、连线或准备生成草稿。"}
              </p>
            </div>
          )}
          {messages.map((msg) => (
            <MessageRow
              key={msg.id}
              msg={msg}
              nodesByShortId={nodesByShortId}
              selectedApplyTarget={selectedApplyTarget}
              onFocusNode={focusNodeOnCanvas}
              onDraftVideo={prepareVideo}
              onApplyToSelectedNode={handleApplyToSelectedNode}
            />
          ))}
          {activeRun && (
            <div className="chat-dock__step">
              <span className="chat-dock__step-dots" aria-hidden="true">
                ●●●
              </span>
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
            <select
              aria-label="目标视频节点"
              value={draft.nodeId}
              disabled={placingDraft}
              onChange={(e) => setDraft({ ...draft, nodeId: e.target.value })}
            >
              <option value="">选择目标视频节点</option>
              <option value="new">新建视频节点</option>
              {videoNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  #{node.data.shortId} ·{" "}
                  {displayNodeTitle(node.data.title, node.data.type)}
                </option>
              ))}
            </select>
            <textarea
              aria-label="编辑视频提示词"
              value={draft.text}
              rows={3}
              disabled={placingDraft}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
            <small>
              {draft.text.length}/500 ·{" "}
              {draft.text.length > 500
                ? "请精简内容再使用，原文已完整保留。"
                : "只把草稿填入节点；点击生成后才会使用 Flow 账号提交。"}
            </small>
            <div>
              <button
                type="button"
                className="chat-action-link"
                disabled={placingDraft}
                onClick={() => setDraft(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="chat-action-link"
                disabled={
                  placingDraft ||
                  !draft.text.trim() ||
                  draft.text.length > 500 ||
                  (draft.nodeId !== "new" &&
                    !videoNodes.some((n) => n.id === draft.nodeId))
                }
                onClick={() => void openVideoDraft()}
              >
                {placingDraft
                  ? "正在定位…"
                  : draft.nodeId === "new"
                    ? "新建节点并填入"
                    : "填入视频节点"}
              </button>
            </div>
          </section>
        )}

        <div className="chat-dock__composer">
          {/* 画布选中节点实时联动引用区 */}
          {nodes.length > 0 && (
            <div className="chat-canvas-refs" ref={pickerWrapRef}>
              <div className="chat-canvas-refs__bar">
                <span className="chat-canvas-refs__title">
                  {activeCanvasRefs.length > 0
                    ? `已引用画布节点 (${activeCanvasRefs.length})`
                    : "点击画布节点可自动引用"}
                </span>
                <div className="chat-canvas-refs__bar-actions">
                  {mutedSelectedCount > 0 && (
                    <button
                      type="button"
                      className="chat-canvas-refs__restore"
                      onClick={() => setMutedSelectedIds(new Set())}
                      title="重新引用当前画布选中的节点"
                    >
                      恢复选中 ({mutedSelectedCount})
                    </button>
                  )}
                  <button
                    type="button"
                    className={`chat-canvas-refs__pick-btn${slashMenuOpen ? " chat-canvas-refs__pick-btn--open" : ""}`}
                    onClick={() => setSlashMenuOpen((v) => !v)}
                    disabled={pending || uploading || activeRun !== null}
                    title="唤出 / 斜杠导演技能菜单"
                  >
                    / 导演技能
                  </button>
                  <button
                    type="button"
                    className={`chat-canvas-refs__pick-btn${nodePickerOpen ? " chat-canvas-refs__pick-btn--open" : ""}`}
                    onClick={() => {
                      setNodePickerOpen((v) => !v);
                      setNodeFilterQuery("");
                    }}
                    disabled={pending || uploading || activeRun !== null}
                    aria-expanded={nodePickerOpen}
                    title="从当前画布选择任意节点加入对话引用"
                  >
                    + 引用节点
                  </button>
                </div>
              </div>

              {activeCanvasRefs.length > 0 && (
                <div className="chat-canvas-refs__chips" aria-label="当前引用的画布节点">
                  {activeCanvasRefs.map(({ node, source }) => {
                    const label = displayNodeTitle(node.data.title, node.data.type);
                    return (
                      <div
                        key={node.id}
                        className={`chat-node-ref${source === "selected" ? " chat-node-ref--selected" : ""}`}
                      >
                        <button
                          type="button"
                          className="chat-node-ref__main"
                          onClick={() => focusNodeOnCanvas(node.data.shortId)}
                          title={`${label} #${node.data.shortId}${source === "selected" ? "（画布已选中 · 点击居中定位）" : "（手动固定引用 · 点击定位）"}`}
                        >
                          <NodeThumbBadge node={node} />
                          <span className="chat-node-ref__name">{label}</span>
                          <span className="chat-node-ref__id">#{node.data.shortId}</span>
                        </button>
                        <button
                          type="button"
                          className="chat-node-ref__remove"
                          onClick={() => handleDismissCanvasRef(node.id, source)}
                          aria-label={`取消引用节点 #${node.data.shortId}`}
                          title="本次对话暂不引用此节点"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {activeCanvasRefs.length > 0 && !text.trim() && (
                <div className="chat-canvas-refs__starters" aria-label="基于引用节点的快捷提问">
                  {quickStarters.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="chat-starter-chip"
                      disabled={pending || uploading || activeRun !== null}
                      onClick={() => {
                        setText(item.prompt);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}

              {nodePickerOpen && (
                <div className="chat-node-picker" role="dialog" aria-label="选择要引用的画布节点">
                  <input
                    type="text"
                    className="chat-node-picker__search"
                    placeholder="搜索节点标题、#编号或提示词…"
                    value={nodeFilterQuery}
                    onChange={(e) => setNodeFilterQuery(e.target.value)}
                    aria-label="筛选画布节点"
                  />
                  <div className="chat-node-picker__list">
                    {pickerCandidates.length === 0 ? (
                      <div className="chat-node-picker__empty">未找到匹配的画布节点</div>
                    ) : (
                      pickerCandidates.map((n) => {
                        const checked = activeCanvasRefs.some((r) => r.node.id === n.id);
                        const label = displayNodeTitle(n.data.title, n.data.type);
                        return (
                          <button
                            key={n.id}
                            type="button"
                            className={`chat-node-picker__item${checked ? " chat-node-picker__item--checked" : ""}`}
                            onClick={() => handleTogglePickerNode(n)}
                          >
                            <NodeThumbBadge node={n} />
                            <span className="chat-node-picker__item-title">{label}</span>
                            <span className="chat-node-picker__item-id">#{n.data.shortId}</span>
                            <span className="chat-node-picker__item-check" aria-hidden="true">
                              {checked ? "✓" : ""}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <p className="chat-data-hint">
            {mode === "analyze"
              ? "仅分析，不修改画布。"
              : "编排可能修改画布并消耗生成额度。"}{" "}
            已引用节点画面、摘要与对话将发给所选模型。
          </p>
          {oversizedImage && (
            <p className="chat-dock__notice" role="status">
              当前模型的单图上限为 {maxFileMiB} MiB，请移除超限图片后再发送。
            </p>
          )}
          {files.length > 0 && provider && !provider.supportsVision && (
            <p className="chat-dock__notice">
              该模型服务不支持图片，请移除参考图或切换提供商。
            </p>
          )}
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
          {(slashMenuOpen || text.startsWith("/")) && slashSkills.length > 0 && (
            <div className="jm-slash-popover" role="listbox" aria-label="斜杠导演技能">
              {slashSkills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  className="jm-slash-popover__item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelectDirectorSkill(skill);
                  }}
                >
                  <div className="jm-slash-popover__top">
                    <span className="jm-slash-popover__cmd">{skill.slash}</span>
                    <span className="jm-slash-popover__badge">{skill.badge}</span>
                  </div>
                  <div className="jm-slash-popover__desc">{skill.desc}</div>
                </button>
              ))}
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
                  .catch((err) =>
                    notifyError(err instanceof Error ? err.message : "选择图片失败"),
                  );
              }}
              disabled={
                pending ||
                uploading ||
                activeRun !== null ||
                provider?.supportsVision === false
              }
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
              onChange={(e) => {
                const val = e.target.value;
                setText(val);
                if (val.startsWith("/")) {
                  setSlashMenuOpen(true);
                } else if (slashMenuOpen && val.trim().length > 0) {
                  setSlashMenuOpen(false);
                }
                if (/(?:^|\s)#$/.test(val) && nodes.length > 0) {
                  setNodePickerOpen(true);
                  setNodeFilterQuery("");
                }
              }}
              onKeyDown={handleKeyDown}
              placeholder={
                activeRun
                  ? "AI 正在执行画布任务…"
                  : activeCanvasRefs.length > 0
                    ? mode === "analyze"
                      ? `已自动引用 ${activeCanvasRefs.map((r) => `#${r.node.data.shortId}`).join(" ")}，输入想分析的问题或直接发送…`
                      : `已自动引用 ${activeCanvasRefs.map((r) => `#${r.node.data.shortId}`).join(" ")}，输入创作编排指令…`
                    : mode === "analyze"
                      ? "点选画布节点自动引用，或输入问题…"
                      : "点选画布节点自动引用，描述希望执行的创作任务…"
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
      <AiProviderDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}
