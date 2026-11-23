import { useRef, useState, type ReactNode } from "react";
import { useReactFlow } from "@xyflow/react";
import { useBoardStore, type NodeType } from "../store/board";
import { useReferencesStore } from "../store/references";
import { useGenerationStore } from "../store/generation";
import { patchNode, uploadImage } from "../api/client";
import { requestAutoBrief } from "../api/autoBrief";
import { collectOccupiedBoxes, findFreeCanvasPosition, type CanvasBox } from "../lib/canvasLayout";
import { pickImageFiles } from "../lib/filePicker";
import {
  IconAssetLibrary,
  IconAudio,
  IconDirectorStage,
  IconImage,
  IconLayers,
  IconNote,
  IconStoryboard,
  IconSubject,
  IconText,
  IconTimeline,
  IconUpload,
  IconVideo,
} from "../components/JimengIcons";
import "./LeftFloatingDock.css";

type DockToolItem =
  | {
      id: string;
      action: "node";
      type: NodeType;
      label: string;
      renderIcon: () => JSX.Element;
      dot?: boolean;
      beta?: boolean;
      subAction?: { label: string; type: NodeType };
    }
  | {
      id: string;
      action: "audio" | "timeline" | "director_stage" | "layers";
      label: string;
      renderIcon: () => JSX.Element;
      dot?: boolean;
      beta?: boolean;
    };

const CREATION_TOOLS: DockToolItem[] = [
  {
    id: "prompt",
    action: "node",
    type: "prompt",
    label: "文本",
    renderIcon: () => <IconText size={18} />,
  },
  {
    id: "image",
    action: "node",
    type: "image",
    label: "图片",
    renderIcon: () => <IconImage size={18} />,
  },
  {
    id: "video",
    action: "node",
    type: "video",
    label: "视频",
    renderIcon: () => <IconVideo size={18} />,
  },
  {
    id: "audio",
    action: "audio",
    label: "音频",
    renderIcon: () => <IconAudio size={18} />,
  },
  {
    id: "timeline",
    action: "timeline",
    label: "时间线",
    renderIcon: () => <IconTimeline size={18} />,
  },
  {
    id: "subject",
    action: "node",
    type: "character",
    label: "主体",
    renderIcon: () => <IconSubject size={18} />,
    subAction: { label: "物品素材", type: "visual_asset" },
  },
  {
    id: "storyboard",
    action: "node",
    type: "Storyboard",
    label: "导演工具箱",
    renderIcon: () => <IconStoryboard size={18} />,
    dot: true,
  },
  {
    id: "director-stage",
    action: "director_stage",
    label: "导演台",
    renderIcon: () => <IconDirectorStage size={18} />,
    beta: true,
  },
  {
    id: "layers",
    action: "layers",
    label: "图层编辑",
    renderIcon: () => <IconLayers size={18} />,
  },
  {
    id: "note",
    action: "node",
    type: "note",
    label: "便签",
    renderIcon: () => <IconNote size={18} />,
  },
];

const ACCEPT_MIME = "image/png,image/jpeg,image/webp,image/gif";

function DockAction({
  label, accessibleLabel, icon, onClick, badge, beta, pressed, busy, disabled,
}: {
  label: string;
  accessibleLabel: string;
  icon: ReactNode;
  onClick: () => void;
  badge?: boolean;
  beta?: boolean;
  pressed?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="jm-dock-action"
      aria-label={accessibleLabel}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="jm-dock-action__icon" aria-hidden="true">
        {icon}
        {badge && <span className="jm-left-dock__dot" />}
        {beta && <span className="jm-left-dock__beta">Beta</span>}
      </span>
      <span className="jm-dock-action__label" aria-hidden="true">{label}</span>
    </button>
  );
}

/**
 * 即梦风格左侧垂直悬浮工具坞（对齐 02-left-dock-expanded.png）：
 * - 默认 44px 纯图标悬浮轨
 * - Hover 时右侧浮层展开中文标签（不推挤画布，零视口抖动）
 * - 上区 10 个核心创作与导演编排入口 + 下区「资产库」与「上传」
 */
export function LeftFloatingDock() {
  const { screenToFlowPosition, viewportInitialized } = useReactFlow();
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const panelOpen = useReferencesStore((s) => s.panelOpen);
  const openPanel = useReferencesStore((s) => s.openPanel);
  const setPanelOpen = useReferencesStore((s) => s.setPanelOpen);

  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef(new Map<string, { x: number; y: number }>());
  const [uploading, setUploading] = useState(false);

  function getViewportCenterFlowPos(offset = 0) {
    return screenToFlowPosition({
      x: window.innerWidth / 2 + offset,
      y: window.innerHeight / 2 + offset,
    });
  }

  function findFreeSpawnPos(width = 256, height = 260, extraBoxes: CanvasBox[] = []): { x: number; y: number } {
    const { nodes } = useBoardStore.getState();
    const center = getViewportCenterFlowPos();
    const origin = { x: center.x - 128, y: center.y - 96 };
    const min = screenToFlowPosition({ x: 75, y: 50 });
    const max = screenToFlowPosition({ x: window.innerWidth - 24, y: window.innerHeight - 54 });
    const pendingBoxes: CanvasBox[] = Array.from(
      pendingRef.current.values(),
      (position) => ({ x: position.x, y: position.y, width: 256, height: 260 }),
    );
    const occupied = collectOccupiedBoxes(nodes, [...pendingBoxes, ...extraBoxes]);
    return findFreeCanvasPosition({
      origin,
      occupied,
      width,
      height,
      minBounds: min,
      maxBounds: max,
    });
  }

  function selectSingleNode(rfId: string) {
    const state = useBoardStore.getState();
    state.setNodes(state.nodes.map((node) => {
      const selected = node.id === rfId;
      return Boolean(node.selected) === selected ? node : { ...node, selected };
    }));
  }

  function ensureBoardReady(): number | null {
    const { boardId, loading } = useBoardStore.getState();
    if (loading || (boardId !== null && !viewportInitialized)) {
      useBoardStore.setState({ error: "画布正在加载，请稍后再试。" });
      return null;
    }
    if (boardId === null) {
      useBoardStore.setState({ error: "画布尚未打开，请检查本地服务连接，或从左上角打开画布。" });
      return null;
    }
    return boardId;
  }

  async function handleSpawn(type: NodeType, label: string) {
    const boardId = ensureBoardReady();
    if (boardId === null || pendingRef.current.has(type)) return;
    const pos = findFreeSpawnPos();
    pendingRef.current.set(type, pos);
    setPending(new Set(pendingRef.current.keys()));
    try {
      const id = await addNodeOfType(type, pos);
      if (useBoardStore.getState().boardId !== boardId) return;
      if (!id) {
        useBoardStore.setState({ error: `创建${label}节点失败，请检查本地服务连接后重试。` });
        return;
      }
      selectSingleNode(id);
    } finally {
      pendingRef.current.delete(type);
      setPending(new Set(pendingRef.current.keys()));
    }
  }

  function handleDirectorStage(tab: "script" | "remake" = "script") {
    window.dispatchEvent(
      new CustomEvent("flowboard:open-director-stage", { detail: { tab } }),
    );
  }

  function handleLayersAction() {
    const { nodes } = useBoardStore.getState();
    const selected = nodes.find(
      (n) =>
        n.selected &&
        n.data.mediaId &&
        n.data.type !== "prompt" &&
        n.data.type !== "note" &&
        n.data.type !== "video",
    );
    window.dispatchEvent(
      new CustomEvent("flowboard:open-layer-editor", { detail: { rfId: selected?.id } }),
    );
  }

  function handleToolClick(item: DockToolItem) {
    if (item.action === "node") {
      void handleSpawn(item.type, item.label);
      return;
    }
    if (item.action === "audio") {
      const { nodes } = useBoardStore.getState();
      const selectedVid = nodes.find((n) => n.selected && n.data.type === "video");
      window.dispatchEvent(
        new CustomEvent("flowboard:open-audio-director", {
          detail: { tab: "voice", rfId: selectedVid?.id },
        }),
      );
      return;
    }
    if (item.action === "timeline") {
      window.dispatchEvent(new Event("flowboard:open-sequence-player"));
      return;
    }
    if (item.action === "director_stage") {
      handleDirectorStage("script");
      return;
    }
    handleLayersAction();
  }

  async function handlePickAndUpload() {
    if (uploading) return;
    try {
      const picked = await pickImageFiles({
        multiple: true,
        accept: ACCEPT_MIME,
        title: "上传本地素材图片",
      });
      if (picked.length > 0) {
        await handleQuickUpload(picked);
      }
    } catch (err) {
      useGenerationStore.setState({
        error: err instanceof Error ? err.message : "选择图片失败，请重试。",
      });
    }
  }

  async function handleQuickUpload(files: File[] | FileList | null) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0 || uploading) return;
    setUploading(true);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding) {
        useGenerationStore.setState({
          error: "尚未配置 Google Flow 项目 ID，请先在右上角「更多 ··· → 生成引擎与项目设置」中配置。",
        });
        return;
      }

      const batchBoxes: CanvasBox[] = [];
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const pos = findFreeSpawnPos(256, 300, batchBoxes);
        batchBoxes.push({ x: pos.x, y: pos.y, width: 256, height: 300 });
        const rfId = await addNodeOfType("visual_asset", pos);
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
    } finally {
      setUploading(false);
    }
  }

  return (
    <nav className="jm-left-dock jm-left-dock--interactive" aria-label="节点与资产工具栏">
      <div className="jm-left-dock__rail">
        <div className="jm-left-dock__group">
          {CREATION_TOOLS.map((item) => {
            const busyKey = item.action === "node" ? item.type : item.action;
            const subAction = item.action === "node" ? item.subAction : undefined;
            return (
              <div key={item.id} className="jm-left-dock__row">
                <DockAction
                  label={item.label}
                  accessibleLabel={
                    item.action === "node" ? `添加${item.label}节点` : item.label
                  }
                  icon={item.renderIcon()}
                  badge={item.dot}
                  beta={item.beta}
                  busy={pending.has(busyKey)}
                  onClick={() => handleToolClick(item)}
                />
                {subAction && (
                  <button
                    type="button"
                    className="jm-left-dock__sub-chip jm-dock-action__secondary"
                    aria-label={`添加${subAction.label}节点`}
                    aria-busy={pending.has(subAction.type) || undefined}
                    onClick={() => void handleSpawn(subAction.type, subAction.label)}
                  >
                    + {subAction.label}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="jm-left-dock__divider" role="separator" />

        <div className="jm-left-dock__group">
          <div className="jm-left-dock__row">
            <DockAction
              label="资产库"
              accessibleLabel="打开资产库"
              icon={<IconAssetLibrary size={18} />}
              pressed={panelOpen}
              onClick={() => (panelOpen ? setPanelOpen(false) : openPanel("assets"))}
            />
          </div>
          <div className="jm-left-dock__row">
            <DockAction
              label={uploading ? "上传中…" : "上传"}
              accessibleLabel="上传本地素材"
              icon={<IconUpload size={18} />}
              busy={uploading}
              disabled={uploading}
              onClick={() => void handlePickAndUpload()}
            />
          </div>
        </div>
      </div>
    </nav>
  );
}
