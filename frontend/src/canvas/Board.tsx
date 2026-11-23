import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  useInternalNode,
  useViewport,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectStartParams,
  type OnNodeDrag,
} from "@xyflow/react";

import { useBoardStore, type FlowNode, type NodeType } from "../store/board";
import { useReferencesStore } from "../store/references";
import { GenerationComposer } from "../components/GenerationDialog";
import { SequencePlayerModal } from "../components/SequencePlayerModal";
import "./ContextualPromptBar.css";
import { NodeCard } from "./NodeCard";
import { VariantEdge } from "./VariantEdge";
import { ViewportCapsule } from "./ViewportCapsule";
import { useGenerationStore } from "../store/generation";
import { patchNode, uploadImage } from "../api/client";
import { requestAutoBrief } from "../api/autoBrief";
import { pickImageFiles } from "../lib/filePicker";
import { STARTER_RECIPES } from "../constants/starterTemplates";
import {
  IconAssetLibrary,
  IconImage,
  IconNote,
  IconStoryboard,
  IconSubject,
  IconText,
  IconUpload,
  IconVideo,
  IconVisualAsset,
  JimengPrismLogo,
} from "../components/JimengIcons";

const nodeTypes = {
  character: NodeCard,
  image: NodeCard,
  video: NodeCard,
  prompt: NodeCard,
  note: NodeCard,
  visual_asset: NodeCard,
  Storyboard: NodeCard,
};

const edgeTypes = {
  default: VariantEdge,
};

const defaultEdgeOptions = {
  style: { stroke: "rgba(255, 255, 255, 0.2)", strokeWidth: 1.8, cursor: "pointer" },
  interactionWidth: 24,
};

interface QuickMenuState {
  clientX: number;
  clientY: number;
  /** 若由节点连接柄拖出松开触发，则携带上游节点 ID 并自动连线 */
  sourceId: string | null;
}

const PANE_CREATE_ITEMS: Array<{
  type: NodeType;
  label: string;
  desc: string;
  renderIcon: () => JSX.Element;
}> = [
  { type: "prompt", label: "文本", desc: "编写脚本与提示词", renderIcon: () => <IconText size={15} /> },
  { type: "image", label: "图片", desc: "文生图 / 多参考合成", renderIcon: () => <IconImage size={15} /> },
  { type: "video", label: "视频", desc: "图生视频 / 多镜头动态", renderIcon: () => <IconVideo size={15} /> },
  { type: "character", label: "主体", desc: "动漫 / 真人 / 3D / 萌宠设定", renderIcon: () => <IconSubject size={15} /> },
  { type: "visual_asset", label: "物品素材", desc: "商品/道具参考与精修", renderIcon: () => <IconVisualAsset size={15} /> },
  { type: "Storyboard", label: "故事板", desc: "连续分镜宫格生成", renderIcon: () => <IconStoryboard size={15} /> },
  { type: "note", label: "便签", desc: "画布自由批注", renderIcon: () => <IconNote size={15} /> },
];

const EDGE_DROP_ITEMS: Array<{
  type: NodeType;
  label: string;
  renderIcon: () => JSX.Element;
}> = [
  { type: "image", label: "生成图片", renderIcon: () => <IconImage size={15} /> },
  { type: "video", label: "生成视频", renderIcon: () => <IconVideo size={15} /> },
  { type: "character", label: "生成主体", renderIcon: () => <IconSubject size={15} /> },
  { type: "Storyboard", label: "生成故事板", renderIcon: () => <IconStoryboard size={15} /> },
];

function QuickCreatePopover({
  menu,
  onPick,
  onOpenAssets,
  onTriggerUpload,
  onClose,
}: {
  menu: QuickMenuState | null;
  onPick: (type: NodeType, flowPos: { x: number; y: number }) => void;
  onOpenAssets: () => void;
  onTriggerUpload: (flowPos: { x: number; y: number }) => void;
  onClose: () => void;
}) {
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    if (!menu) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onOutside = (e: Event) => {
      const node = e.target as Node | null;
      const el = node instanceof Element ? node : node?.parentElement ?? null;
      if (el?.closest(".drop-popover")) return;
      onClose();
    };
    // 捕获阶段监听可在 ReactFlow / d3-zoom 阻止冒泡前第一时间关闭创建菜单
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("contextmenu", onOutside, true);
    document.addEventListener("wheel", onOutside, { capture: true, passive: true });
    document.addEventListener("keydown", onEsc, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("contextmenu", onOutside, true);
      document.removeEventListener("wheel", onOutside, { capture: true });
      document.removeEventListener("keydown", onEsc, true);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const isEdgeDrop = menu.sourceId !== null;
  const estHeight = isEdgeDrop ? 168 : 456;
  const clampedX = Math.max(12, Math.min(menu.clientX + 6, window.innerWidth - 232));
  const clampedY = Math.max(12, Math.min(menu.clientY + 6, window.innerHeight - estHeight));

  const handle = (type: NodeType) => {
    const flowPos = screenToFlowPosition({ x: menu.clientX, y: menu.clientY });
    onPick(type, flowPos);
  };

  return createPortal(
    <div
      className="drop-popover"
      style={{ left: clampedX, top: clampedY }}
      role="menu"
      aria-label={isEdgeDrop ? "添加下游连接节点" : "创建节点"}
    >
      <div className="drop-popover__header">
        {isEdgeDrop ? "连接至新节点" : "创建节点"}
      </div>
      {isEdgeDrop ? (
        EDGE_DROP_ITEMS.map((item) => (
          <button
            key={item.type}
            type="button"
            className="drop-popover__btn"
            onClick={() => handle(item.type)}
          >
            <span className="drop-popover__icon">{item.renderIcon()}</span>
            <span>{item.label}</span>
          </button>
        ))
      ) : (
        <>
          {PANE_CREATE_ITEMS.map((item) => (
            <button
              key={item.type}
              type="button"
              className="drop-popover__btn"
              onClick={() => handle(item.type)}
            >
              <span className="drop-popover__icon">{item.renderIcon()}</span>
              <span className="drop-popover__btn-text">
                <span className="drop-popover__btn-label">{item.label}</span>
                <span className="drop-popover__btn-desc">{item.desc}</span>
              </span>
            </button>
          ))}
          <div className="drop-popover__divider" />
          <button
            type="button"
            className="drop-popover__btn"
            onClick={() => {
              onClose();
              onOpenAssets();
            }}
          >
            <span className="drop-popover__icon">
              <IconAssetLibrary size={15} />
            </span>
            <span className="drop-popover__btn-label">从资产库选择…</span>
          </button>
          <button
            type="button"
            className="drop-popover__btn"
            onClick={() => {
              const flowPos = screenToFlowPosition({ x: menu.clientX, y: menu.clientY });
              onClose();
              onTriggerUpload(flowPos);
            }}
          >
            <span className="drop-popover__icon">
              <IconUpload size={15} />
            </span>
            <span className="drop-popover__btn-label">上传本地图片…</span>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

const INITIAL_FIT_OPTIONS = { maxZoom: 1 };
const CONTEXT_NODE_TYPES = new Set<NodeType>(["prompt", "image", "video", "character", "Storyboard"]);
const ACCEPT_IMAGE_MIME = "image/png,image/jpeg,image/webp,image/gif";

function supportsContextualBar(node: FlowNode): boolean {
  if (CONTEXT_NODE_TYPES.has(node.data.type)) return true;
  return node.data.type === "visual_asset" && !node.data.mediaId;
}

function ContextualPromptBar({ node }: { node: FlowNode }) {
  const internal = useInternalNode(node.id);
  const { x, y, zoom } = useViewport();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const measuredWidth = internal?.measured.width;
  const measuredHeight = internal?.measured.height;
  if (!internal || !measuredWidth || !measuredHeight || width < 120 || height < 120) return null;

  const origin = internal.internals.positionAbsolute;
  const left = x + origin.x * zoom;
  const top = y + origin.y * zoom;
  const right = left + measuredWidth * zoom;
  const bottom = top + measuredHeight * zoom;
  if (right < 0 || left > width || bottom < 0 || top > height) return null;

  // Position in screen pixels: the bar follows pan/zoom while remaining readable.
  const gutter = width >= 640 ? 70 : 12;
  const panelWidth = Math.min(580, width - gutter * 2);
  const center = (left + right) / 2;
  const panelLeft = Math.max(gutter, Math.min(center - panelWidth / 2, width - gutter - panelWidth));
  const below = height - bottom - 24;
  const above = top - 70;
  const preferAbove = below < 260 && above > below;
  const fit = preferAbove ? above : below;
  const fallback = fit < 220;

  return (
    <div
      className="jm-context-anchor"
      style={{
        left: panelLeft,
        width: panelWidth,
        top: fallback ? undefined : preferAbove ? top - 34 : bottom + 12,
        bottom: fallback ? 56 : undefined,
        transform: !fallback && preferAbove ? "translateY(-100%)" : undefined,
        maxHeight: fallback ? Math.min(480, Math.max(200, height - 114)) : fit,
      }}
    >
      <GenerationComposer rfId={node.id} initialPrompt={(node.data.type === "Storyboard" ? node.data.aiBrief : node.data.prompt) ?? ""} inline />
    </div>
  );
}

export function Board() {
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const setNodes = useBoardStore((s) => s.setNodes);
  const setEdges = useBoardStore((s) => s.setEdges);
  const persistNodePosition = useBoardStore((s) => s.persistNodePosition);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const deleteNodeByRfId = useBoardStore((s) => s.deleteNodeByRfId);
  const deleteEdgeByRfId = useBoardStore((s) => s.deleteEdgeByRfId);
  const importHuabuFile = useBoardStore((s) => s.importHuabuFile);
  const applyStarterRecipe = useBoardStore((s) => s.applyStarterRecipe);
  const groupNodes = useBoardStore((s) => s.groupNodes);
  const ungroupNodes = useBoardStore((s) => s.ungroupNodes);
  const exportCurrentBoardHuabu = useBoardStore((s) => s.exportCurrentBoardHuabu);
  const setPanelOpen = useReferencesStore((s) => s.setPanelOpen);
  const { screenToFlowPosition, fitView, getZoom } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const huabuInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [dragHintVisible, setDragHintVisible] = useState(false);
  const [starterBusyId, setStarterBusyId] = useState<string | null>(null);

  const [quickMenu, setQuickMenu] = useState<QuickMenuState | null>(null);
  const quickMenuOpenedAtRef = useRef(0);
  const closeQuickMenu = useCallback(() => setQuickMenu(null), []);
  const handlePaneClick = useCallback(() => {
    // 连线松手触发 onConnectEnd 后同一手势可能派发合成 click，留 80ms 保护窗口
    if (performance.now() - quickMenuOpenedAtRef.current < 80) return;
    setQuickMenu(null);
  }, []);
  const [edgesHidden, setEdgesHidden] = useState(false);
  const [sequenceOpen, setSequenceOpen] = useState(false);
  const [focusVideo, setFocusVideo] = useState<string | null>(null);

  useEffect(() => {
    const onOpenSeq = () => setSequenceOpen(true);
    window.addEventListener("flowboard:open-sequence-player", onOpenSeq);
    return () => window.removeEventListener("flowboard:open-sequence-player", onOpenSeq);
  }, []);
  const focusMeasured = useStore(state => !!(focusVideo && state.nodeLookup.get(focusVideo)?.measured.width));
  // Only center on an explicit handoff, not on ordinary typing, panning or account polling.
  useEffect(() => useGenerationStore.subscribe((next, previous) => {
    const draft = next.videoDraft;
    if (!draft || draft.revision === previous.videoDraft?.revision) return;
    setQuickMenu(null);
    setFocusVideo(draft.rfId);
  }), []);
  useEffect(() => {
    if (!focusVideo || !focusMeasured) return;
    // A newly created node becomes measurable after the store insertion.
    void fitView({
      nodes: [{ id: focusVideo }], maxZoom: Math.min(1, getZoom()), minZoom: Math.min(0.5, getZoom()),
      padding: 0.5, duration: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 200,
    });
    setFocusVideo(null);
  }, [focusVideo, focusMeasured, fitView, getZoom]);
  const connectStateRef = useRef<{ sourceId: string | null; didConnect: boolean }>({
    sourceId: null,
    didConnect: false,
  });

  const onCanvasDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      dragDepthRef.current += 1;
      setDragHintVisible(true);
    }
  }, []);

  const onCanvasDragLeave = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragHintVisible(false);
    }
  }, []);

  const onCanvasDragOver = useCallback((e: React.DragEvent) => {
    const hasRef = e.dataTransfer.types.includes("application/x-flowboard-reference");
    const hasFiles = e.dataTransfer.types.includes("Files");
    if (hasRef || hasFiles) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const uploadImagesAtPosition = useCallback(
    async (files: File[], baseFlowPos: { x: number; y: number }) => {
      if (files.length === 0) return;
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding) {
        useGenerationStore.setState({
          error: "尚未配置 Google Flow 项目 ID，无法上传图片。",
        });
        return;
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const flowPos = { x: baseFlowPos.x + i * 36, y: baseFlowPos.y + i * 36 };
        const rfId = await addNodeOfType("visual_asset", flowPos);
        if (!rfId) continue;
        const dbId = parseInt(rfId, 10);
        const cleanTitle = file.name.replace(/\.[^.]+$/, "") || "物品素材";
        useBoardStore.getState().updateNodeData(rfId, {
          title: cleanTitle,
          status: "running",
        });
        try {
          const resp = await uploadImage(
            file,
            binding.flow_project_id,
            isNaN(dbId) ? undefined : dbId,
            binding.flow_account_id,
          );
          useBoardStore.getState().updateNodeData(rfId, {
            title: cleanTitle,
            mediaId: resp.media_id,
            mediaIds: [resp.media_id],
            variantCount: 1,
            status: "done",
            aspectRatio: resp.aspect_ratio,
            renderedAt: new Date().toISOString(),
          });
          if (!isNaN(dbId)) {
            await patchNode(dbId, {
              status: "done",
              data: {
                title: cleanTitle,
                mediaId: resp.media_id,
                mediaIds: [resp.media_id],
                variantCount: 1,
                aspectRatio: resp.aspect_ratio,
                renderedAt: new Date().toISOString(),
              },
            }).catch(() => {});
          }
          requestAutoBrief(rfId, resp.media_id);
        } catch (err) {
          useBoardStore.getState().updateNodeData(rfId, {
            status: "error",
            error: err instanceof Error ? err.message : "上传失败",
          });
        }
      }
    },
    [addNodeOfType],
  );

  const onCanvasDrop = useCallback(
    async (e: React.DragEvent) => {
      dragDepthRef.current = 0;
      setDragHintVisible(false);

      // 1. 资产库卡片拖入画布
      const raw = e.dataTransfer.getData("application/x-flowboard-reference");
      if (raw) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const ref = JSON.parse(raw) as {
            mediaId: string;
            aiBrief?: string | null;
            aspectRatio?: string | null;
            kind: string;
            label: string;
          };
          const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          await useBoardStore.getState().addReferenceNode(ref, flowPos);
        } catch (err) {
          console.warn("Failed to parse reference drop payload", err);
        }
        return;
      }

      // 2. .huabu 工作流配方包拖入画布一键导入
      const allFiles = Array.from(e.dataTransfer.files ?? []);
      const huabuFile = allFiles.find((f) => f.name.toLowerCase().endsWith(".huabu"));
      if (huabuFile) {
        e.preventDefault();
        e.stopPropagation();
        const imported = await importHuabuFile(huabuFile);
        if (imported) {
          setTimeout(() => void fitView({ duration: 280, padding: 0.22 }), 80);
        }
        return;
      }

      // 3. 本地图片文件直接拖入空白画布自动创建节点
      const droppedFiles = allFiles.filter((f) => f.type.startsWith("image/"));
      if (droppedFiles.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      await uploadImagesAtPosition(droppedFiles, flowPos);
    },
    [screenToFlowPosition, uploadImagesAtPosition, importHuabuFile, fitView],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) {
        if (c.type === "remove") {
          void deleteNodeByRfId(c.id);
        }
      }
      setNodes(applyNodeChanges(changes, useBoardStore.getState().nodes) as FlowNode[]);
    },
    [setNodes, deleteNodeByRfId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === "remove") {
          void deleteEdgeByRfId(c.id);
        }
      }
      setEdges(applyEdgeChanges(changes, useBoardStore.getState().edges));
    },
    [setEdges, deleteEdgeByRfId],
  );

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, node) => {
      void persistNodePosition(node.id, node.position);
    },
    [persistNodePosition],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        void addEdgeFromConnection(connection.source, connection.target);
        connectStateRef.current.didConnect = true;
      }
    },
    [addEdgeFromConnection],
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      if (params.handleType !== "source" || !params.nodeId) {
        connectStateRef.current = { sourceId: null, didConnect: false };
        return;
      }
      connectStateRef.current = { sourceId: params.nodeId, didConnect: false };
    },
    [],
  );

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    const { sourceId, didConnect } = connectStateRef.current;
    connectStateRef.current = { sourceId: null, didConnect: false };
    if (!sourceId || didConnect) return;
    const e = event as MouseEvent;
    const cx = typeof e.clientX === "number" ? e.clientX : window.innerWidth / 2;
    const cy = typeof e.clientY === "number" ? e.clientY : window.innerHeight / 2;
    quickMenuOpenedAtRef.current = performance.now();
    setQuickMenu({ clientX: cx, clientY: cy, sourceId });
  }, []);

  const handlePickAdd = useCallback(
    async (type: NodeType, flowPos: { x: number; y: number }) => {
      const sourceId = quickMenu?.sourceId ?? null;
      setQuickMenu(null);
      const newId = await addNodeOfType(type, flowPos);
      if (newId && sourceId) {
        await addEdgeFromConnection(sourceId, newId);
      }
    },
    [quickMenu, addNodeOfType, addEdgeFromConnection],
  );

  const handleWrapperDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // 仅在点击空白画布区域 (.react-flow__pane) 时唤出即梦式节点创建菜单
    if (target.classList.contains("react-flow__pane") || target.closest(".react-flow__pane")) {
      if (target.closest(".react-flow__node") || target.closest(".react-flow__edge")) {
        return;
      }
      quickMenuOpenedAtRef.current = performance.now();
      setQuickMenu({
        clientX: e.clientX,
        clientY: e.clientY,
        sourceId: null,
      });
    }
  }, []);

  const onNodesDelete = useCallback(
    (deletedNodes: FlowNode[]) => {
      deletedNodes.forEach((n) => void deleteNodeByRfId(n.id));
    },
    [deleteNodeByRfId],
  );

  const onEdgesDelete = useCallback(
    (deletedEdges: { id: string }[]) => {
      deletedEdges.forEach((e) => void deleteEdgeByRfId(e.id));
    },
    [deleteEdgeByRfId],
  );

  const onNodeDoubleClick = useCallback(
    (event: React.MouseEvent, node: FlowNode) => {
      const isGenerable = [
        "image",
        "video",
        "visual_asset",
        "character",
        "Storyboard",
      ].includes(node.data.type);
      if (!isGenerable) return;
      const s = useGenerationStore.getState();
      if (node.data.type === "video") {
        if ((event.target as Element).closest("video,button,input,select,textarea")) return;
        s.openGenerationDialog(node.id, node.data.prompt ?? "");
        return;
      }
      if (node.data.mediaId) {
        s.openResultViewer(node.id);
      } else {
        s.openGenerationDialog(node.id, node.data.prompt ?? "");
      }
    },
    [],
  );

  // 快捷键：选中节点按 g 打开生成/预览，按 l 切换资产库，多选 Ctrl/Cmd+G 编组分镜
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const tag = (active?.tagName ?? "").toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "g") {
        const picked = useBoardStore.getState().nodes.filter((n) => n.selected);
        if (picked.length >= 2) {
          e.preventDefault();
          void useBoardStore.getState().groupNodes(picked.map((n) => n.id));
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "l") {
        e.preventDefault();
        const refs = useReferencesStore.getState();
        if (refs.panelOpen) refs.setPanelOpen(false);
        else refs.openPanel("assets");
        return;
      }
      if (key !== "g") return;

      const selectedNodes = useBoardStore
        .getState()
        .nodes.filter(
          (n) =>
            n.selected &&
            ["image", "prompt", "video", "character", "Storyboard"].includes(
              n.data.type,
            ),
        );
      if (selectedNodes.length === 0) return;
      e.preventDefault();
      const target = selectedNodes[0];
      const s = useGenerationStore.getState();
      if (target.data.mediaId && target.data.type !== "video") {
        s.openResultViewer(target.id);
      } else {
        s.openGenerationDialog(target.id, target.data.prompt ?? "");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const dialogNodeId = useGenerationStore((state) => state.openDialog.rfId);
  const selectedNodes = nodes.filter((node) => node.selected);
  const selected = selectedNodes.length === 1 && supportsContextualBar(selectedNodes[0])
    ? selectedNodes[0]
    : undefined;

  return (
    <div
      ref={wrapperRef}
      className={edgesHidden ? "jm-edges-hidden" : undefined}
      style={{ flex: 1, minHeight: 0, width: "100%", height: "100%", position: "relative" }}
      onDragEnter={onCanvasDragEnter}
      onDragLeave={onCanvasDragLeave}
      onDragOver={onCanvasDragOver}
      onDrop={(e) => void onCanvasDrop(e)}
      onDoubleClick={handleWrapperDoubleClick}
    >
      <input
        ref={huabuInputRef}
        type="file"
        accept=".huabu,application/zip"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          void importHuabuFile(file).then((board) => {
            if (board) setTimeout(() => void fitView({ duration: 280, padding: 0.22 }), 80);
          });
        }}
      />

      {dragHintVisible && (
        <div className="jm-drop-hint" aria-live="polite">
          <div className="jm-drop-hint__card">
            <JimengPrismLogo size={22} />
            <span>松开鼠标 · 导入 .huabu 创作配方或上传图片素材</span>
          </div>
        </div>
      )}

      {/* 即梦风格空画布中心引导（0 节点且未展开创建菜单时浮现） */}
      {nodes.length === 0 && !quickMenu && (
        <div className="jm-empty-stage">
          <div className="jm-empty-guide" aria-hidden="true">
            <span className="jm-empty-guide__text">双击画布</span>
            <span className="jm-empty-guide__logo">
              <JimengPrismLogo size={24} />
            </span>
            <span className="jm-empty-guide__text">创建节点</span>
          </div>

          <div className="jm-starter-guide" role="region" aria-label="新手指引示例画布与配方导入">
            <div className="jm-starter-guide__head">
              <span className="jm-starter-guide__title">快速开局 · 新手指引示例工作流</span>
              <button
                type="button"
                className="jm-starter-guide__import"
                onClick={() => huabuInputRef.current?.click()}
              >
                导入 .huabu 配方包…
              </button>
            </div>
            <div className="jm-starter-guide__grid">
              {STARTER_RECIPES.map((recipe) => {
                const busy = starterBusyId === recipe.id;
                return (
                  <button
                    key={recipe.id}
                    type="button"
                    className="jm-starter-card"
                    disabled={starterBusyId !== null}
                    onClick={() => {
                      setStarterBusyId(recipe.id);
                      void applyStarterRecipe(recipe.id)
                        .then((board) => {
                          if (board) {
                            setTimeout(() => void fitView({ duration: 280, padding: 0.22 }), 80);
                          }
                        })
                        .finally(() => setStarterBusyId(null));
                    }}
                  >
                    <div className="jm-starter-card__top">
                      <span className="jm-starter-card__badge">{recipe.badge}</span>
                      <span className="jm-starter-card__action">
                        {busy ? "载入中…" : "一键铺开 →"}
                      </span>
                    </div>
                    <div className="jm-starter-card__title">{recipe.title}</div>
                    <div className="jm-starter-card__summary">{recipe.summary}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onPaneClick={handlePaneClick}
        onNodeClick={closeQuickMenu}
        onEdgeClick={closeQuickMenu}
        onNodeDoubleClick={onNodeDoubleClick}
        zoomOnDoubleClick={false}
        deleteKeyCode={["Backspace", "Delete"]}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionRadius={32}
        fitView
        fitViewOptions={INITIAL_FIT_OPTIONS}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.15}
          color="rgba(255, 255, 255, 0.11)"
        />
        <ViewportCapsule
          edgesHidden={edgesHidden}
          onToggleEdges={() => setEdgesHidden((v) => !v)}
          onOpenSequence={() => setSequenceOpen(true)}
        />
        <QuickCreatePopover
          menu={quickMenu}
          onPick={(t, pos) => void handlePickAdd(t, pos)}
          onOpenAssets={() => setPanelOpen(true)}
          onTriggerUpload={(pos) => {
            void pickImageFiles({
              multiple: true,
              accept: ACCEPT_IMAGE_MIME,
              title: "上传本地图片到画布",
            })
              .then((picked) => {
                if (picked.length > 0) {
                  void uploadImagesAtPosition(picked, pos);
                }
              })
              .catch((err) => {
                useGenerationStore.setState({
                  error: err instanceof Error ? err.message : "选择图片失败，请重试。",
                });
              });
          }}
          onClose={closeQuickMenu}
        />
      </ReactFlow>
      {selected && !quickMenu && (
        <div hidden={dialogNodeId !== null}>
          <ContextualPromptBar key={selected.id} node={selected} />
        </div>
      )}
      {selectedNodes.length >= 2 && (
        <div className="jm-multi-select-bar" role="toolbar" aria-label="多选节点批量操作">
          <span className="jm-multi-select-bar__count">
            已选 {selectedNodes.length} 个节点
          </span>
          <button
            type="button"
            className="jm-multi-select-bar__btn"
            onClick={() => void groupNodes(selectedNodes.map((n) => n.id))}
            title="将当前多选节点编入同一分镜组（快捷键 Ctrl/⌘ + G）"
          >
            📦 编组分镜 (⌘G)
          </button>
          {selectedNodes.some((n) => Boolean(n.data.groupId)) && (
            <button
              type="button"
              className="jm-multi-select-bar__btn"
              onClick={() => void ungroupNodes(selectedNodes.map((n) => n.id))}
            >
              ✕ 解除编组
            </button>
          )}
          <button
            type="button"
            className="jm-multi-select-bar__btn jm-multi-select-bar__btn--cyan"
            onClick={() => {
              const dbIds = selectedNodes
                .map((n) => parseInt(n.id, 10))
                .filter((id) => !isNaN(id));
              if (dbIds.length > 0) void exportCurrentBoardHuabu(true, dbIds);
            }}
            title="仅将当前选中的节点及内部连线导出为独立 .huabu 子工作流包"
          >
            📤 导出选中 .huabu
          </button>
        </div>
      )}
      <SequencePlayerModal open={sequenceOpen} onClose={() => setSequenceOpen(false)} />
    </div>
  );
}
