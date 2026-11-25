import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, useViewport } from "@xyflow/react";
import { useBoardStore, type FlowNode, type NodeType } from "../store/board";
import { useGenerationStore } from "../store/generation";
import {
  collectSelectedMediaDownloads,
  computeArrangedPositions,
  computeRightSpawnPosition,
  resolveNodeBox,
  type ArrangeMode,
  type ArrangeNodeBox,
} from "../lib/canvasArrange";
import "./SelectionActionBar.css";

type OpenMenu = "group" | "organize" | "ai" | null;

const MAX_WIRE_SOURCES = 8;

function IconStack() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="9.5" height="11" rx="2.2" />
      <path d="M13 6.5h1.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H13" />
    </svg>
  );
}

function IconGroup() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="13" height="13" rx="2.5" strokeDasharray="2.5 2" />
      <circle cx="8" cy="8.5" r="2.2" />
      <rect x="9.8" y="9.8" width="4.4" height="4.4" rx="1" />
    </svg>
  );
}

function IconOrganize() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="5.2" height="5.2" rx="1.2" />
      <rect x="11.3" y="3.5" width="5.2" height="5.2" rx="1.2" />
      <rect x="3.5" y="11.3" width="5.2" height="5.2" rx="1.2" />
      <rect x="11.3" y="11.3" width="5.2" height="5.2" rx="1.2" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.5v8.8m-3.2-3 3.2 3.2 3.2-3.2M4 14.5v1.2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1.2" />
    </svg>
  );
}

function IconSparkle() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2.5 11.9 7.8 17.5 10l-5.6 2.2L10 17.5l-1.9-5.3L2.5 10l5.6-2.2L10 2.5Z" />
    </svg>
  );
}

/**
 * 即梦风格框选多节点悬浮操作胶囊（锚定在多选包围盒正上方）：
 * 顺序严格对齐参考图：节点数 · 叠放 · 编组 ▾ · 整理 ▾ · 批量下载 ↓ · ✨ AI 协同 ▾
 */
export function SelectionActionBar({ selectedNodes }: { selectedNodes: FlowNode[] }) {
  const { x: vpX, y: vpY, zoom } = useViewport();
  const canvasWidth = useStore((s) => s.width);
  const canvasHeight = useStore((s) => s.height);
  const nodeLookup = useStore((s) => s.nodeLookup);

  const batchUpdateNodePositions = useBoardStore((s) => s.batchUpdateNodePositions);
  const groupNodes = useBoardStore((s) => s.groupNodes);
  const ungroupNodes = useBoardStore((s) => s.ungroupNodes);
  const exportCurrentBoardHuabu = useBoardStore((s) => s.exportCurrentBoardHuabu);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const addEdgeFromConnection = useBoardStore((s) => s.addEdgeFromConnection);

  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [groupTitleDraft, setGroupTitleDraft] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const selectedSig = selectedNodes.map((n) => n.id).join(",");

  useEffect(() => {
    setOpenMenu(null);
  }, [selectedSig]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (barRef.current && target && barRef.current.contains(target)) return;
      setOpenMenu(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [openMenu]);

  const boxes: ArrangeNodeBox[] = useMemo(() => {
    return selectedNodes.map((n) => {
      const internal = nodeLookup.get(n.id);
      const pos = internal?.internals.positionAbsolute ?? n.position;
      return resolveNodeBox(
        { ...n, position: pos },
        {
          width: internal?.measured.width,
          height: internal?.measured.height,
        },
      );
    });
  }, [selectedNodes, nodeLookup]);

  const downloads = useMemo(
    () => collectSelectedMediaDownloads(selectedNodes),
    [selectedNodes],
  );

  if (selectedNodes.length < 2 || canvasWidth < 120 || canvasHeight < 120) {
    return null;
  }

  // Compute screen-space bounding box of selected nodes so the pill floats right above it
  const minFlowX = Math.min(...boxes.map((b) => b.x));
  const maxFlowRight = Math.max(...boxes.map((b) => b.x + b.width));
  const minFlowY = Math.min(...boxes.map((b) => b.y));
  const screenCenterX = vpX + ((minFlowX + maxFlowRight) / 2) * zoom;
  const screenTopY = vpY + minFlowY * zoom;

  const estBarHalfWidth = Math.min(265, Math.max(160, (canvasWidth - 28) / 2));
  const clampedCenterX = Math.max(
    estBarHalfWidth + 14,
    Math.min(screenCenterX, canvasWidth - estBarHalfWidth - 14),
  );
  const clampedTopY = Math.max(66, Math.min(screenTopY - 18, canvasHeight - 96));

  const hasGrouped = selectedNodes.some((n) => Boolean(n.data.groupId));
  const canDistribute = selectedNodes.length >= 3;

  function runArrange(mode: ArrangeMode) {
    setOpenMenu(null);
    const nextPositions = computeArrangedPositions(boxes, mode);
    const updates = Array.from(nextPositions.entries()).map(([rfId, pos]) => ({
      rfId,
      x: pos.x,
      y: pos.y,
    }));
    if (updates.length > 0) {
      void batchUpdateNodePositions(updates);
    }
  }

  async function handleGroupSubmit(customTitle?: string) {
    const ids = selectedNodes.map((n) => n.id);
    setOpenMenu(null);
    await groupNodes(ids, customTitle?.trim() || "分镜组");
    setGroupTitleDraft("");
  }

  function handleBatchDownload() {
    if (downloads.length === 0) return;
    downloads.forEach((item, idx) => {
      window.setTimeout(() => {
        const a = document.createElement("a");
        a.href = item.url;
        a.download = item.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, idx * 90);
    });
  }

  async function handleAiSynthesizeNode(targetType: Extract<NodeType, "image" | "video" | "Storyboard">) {
    if (aiBusy) return;
    setOpenMenu(null);
    setAiBusy(true);
    try {
      const spawnPos = computeRightSpawnPosition(boxes);
      const newId = await addNodeOfType(targetType, spawnPos);
      if (!newId) return;
      const wireSources = selectedNodes.slice(0, MAX_WIRE_SOURCES);
      for (const src of wireSources) {
        await addEdgeFromConnection(src.id, newId);
      }
      useGenerationStore.getState().openGenerationDialog(newId, "");
    } finally {
      setAiBusy(false);
    }
  }

  function handleOpenAiChat(mode: "analyze" | "create", prompt: string) {
    setOpenMenu(null);
    window.dispatchEvent(
      new CustomEvent("flowboard:open-chat-with-selection", {
        detail: {
          rfIds: selectedNodes.map((n) => n.id),
          mode,
          prompt,
        },
      }),
    );
  }

  return (
    <div
      ref={barRef}
      className="jm-sel-bar nodrag nopan nowheel"
      style={{
        left: clampedCenterX,
        top: clampedTopY,
      }}
      role="toolbar"
      aria-label="框选多节点快捷工具栏"
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* 1. Selected Node Count */}
      <span className="jm-sel-bar__count">
        {selectedNodes.length} 个节点
      </span>

      {/* 2. Stack (叠放) */}
      <button
        type="button"
        className="jm-sel-bar__btn"
        onClick={() => runArrange("stack")}
        title="将选中的节点整齐叠放为紧凑卡片堆"
      >
        <IconStack />
        <span>叠放</span>
      </button>

      {/* 3. Group (编组 ▾) */}
      <div className="jm-sel-bar__menu-wrap">
        <button
          type="button"
          className={`jm-sel-bar__btn${openMenu === "group" ? " jm-sel-bar__btn--active" : ""}`}
          onClick={() => setOpenMenu((m) => (m === "group" ? null : "group"))}
          aria-expanded={openMenu === "group"}
          aria-haspopup="menu"
          title="将选中节点编入同一分镜组或导出配方"
        >
          <IconGroup />
          <span>编组</span>
          <span className="jm-sel-bar__caret" aria-hidden="true">⌄</span>
        </button>

        {openMenu === "group" && (
          <div className="jm-sel-popover" role="menu" aria-label="编组操作">
            <button
              type="button"
              role="menuitem"
              className="jm-sel-popover__item"
              onClick={() => void handleGroupSubmit("分镜组")}
            >
              <span>📦 编入分镜组</span>
              <span className="jm-sel-popover__kbd">⌘G</span>
            </button>

            <form
              className="jm-sel-popover__form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleGroupSubmit(groupTitleDraft);
              }}
            >
              <input
                type="text"
                className="jm-sel-popover__input"
                value={groupTitleDraft}
                onChange={(e) => setGroupTitleDraft(e.target.value)}
                placeholder="自定义组名（回车确认）…"
                maxLength={24}
              />
              <button type="submit" className="jm-sel-popover__ok">
                确定
              </button>
            </form>

            {hasGrouped && (
              <button
                type="button"
                role="menuitem"
                className="jm-sel-popover__item"
                onClick={() => {
                  setOpenMenu(null);
                  void ungroupNodes(selectedNodes.map((n) => n.id));
                }}
              >
                <span>✕ 解除分镜编组</span>
              </button>
            )}

            <div className="jm-sel-popover__divider" />

            <button
              type="button"
              role="menuitem"
              className="jm-sel-popover__item"
              onClick={() => {
                setOpenMenu(null);
                const dbIds = selectedNodes
                  .map((n) => parseInt(n.id, 10))
                  .filter((id) => !isNaN(id));
                if (dbIds.length > 0) void exportCurrentBoardHuabu(true, dbIds);
              }}
            >
              <span>📤 导出选中 .huabu 配方包</span>
            </button>
          </div>
        )}
      </div>

      {/* 4. Organize (整理 ▾) */}
      <div className="jm-sel-bar__menu-wrap">
        <button
          type="button"
          className={`jm-sel-bar__btn${openMenu === "organize" ? " jm-sel-bar__btn--active" : ""}`}
          onClick={() => setOpenMenu((m) => (m === "organize" ? null : "organize"))}
          aria-expanded={openMenu === "organize"}
          aria-haspopup="menu"
          title="智能网格、行列排布、对齐与等距分布"
        >
          <IconOrganize />
          <span>整理</span>
          <span className="jm-sel-bar__caret" aria-hidden="true">⌄</span>
        </button>

        {openMenu === "organize" && (
          <div className="jm-sel-popover jm-sel-popover--wide" role="menu" aria-label="整理与对齐">
            <div className="jm-sel-popover__label">自动排版</div>
            <button type="button" role="menuitem" className="jm-sel-popover__item" onClick={() => runArrange("grid")}>
              <span>⊞ 智能网格整理</span>
              <span className="jm-sel-popover__hint">自动分列</span>
            </button>
            <button type="button" role="menuitem" className="jm-sel-popover__item" onClick={() => runArrange("row")}>
              <span>↔ 水平一字排开</span>
              <span className="jm-sel-popover__hint">分镜横排</span>
            </button>
            <button type="button" role="menuitem" className="jm-sel-popover__item" onClick={() => runArrange("column")}>
              <span>↕ 垂直一列排开</span>
              <span className="jm-sel-popover__hint">纵列清单</span>
            </button>

            <div className="jm-sel-popover__divider" />
            <div className="jm-sel-popover__label">对齐方式</div>
            <div className="jm-sel-popover__align-grid">
              <button type="button" className="jm-sel-popover__chip" onClick={() => runArrange("align_left")} title="左对齐">左对齐</button>
              <button type="button" className="jm-sel-popover__chip" onClick={() => runArrange("align_center_x")} title="水平居中对齐">水平居中</button>
              <button type="button" className="jm-sel-popover__chip" onClick={() => runArrange("align_right")} title="右对齐">右对齐</button>
              <button type="button" className="jm-sel-popover__chip" onClick={() => runArrange("align_top")} title="顶对齐">顶对齐</button>
              <button type="button" className="jm-sel-popover__chip" onClick={() => runArrange("align_center_y")} title="垂直居中对齐">垂直居中</button>
              <button type="button" className="jm-sel-popover__chip" onClick={() => runArrange("align_bottom")} title="底对齐">底对齐</button>
            </div>

            {canDistribute && (
              <>
                <div className="jm-sel-popover__divider" />
                <div className="jm-sel-popover__label">均匀分布</div>
                <div className="jm-sel-popover__dist-row">
                  <button type="button" className="jm-sel-popover__chip" onClick={() => runArrange("distribute_h")}>
                    ⇥ 水平等距
                  </button>
                  <button type="button" className="jm-sel-popover__chip" onClick={() => runArrange("distribute_v")}>
                    ⇣ 垂直等距
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 5. Batch Download (↓) */}
      <span className="jm-sel-bar__sep" aria-hidden="true" />
      <button
        type="button"
        className="jm-sel-bar__icon-btn"
        disabled={downloads.length === 0}
        onClick={handleBatchDownload}
        aria-label={
          downloads.length > 0
            ? `批量下载已选中的 ${downloads.length} 个媒体文件`
            : "选中节点暂无可下载媒体"
        }
        title={
          downloads.length > 0
            ? `批量下载已选中的 ${downloads.length} 个媒体文件`
            : "选中节点暂无已生成的图片或视频"
        }
      >
        <IconDownload />
        {downloads.length > 0 && (
          <span className="jm-sel-bar__dl-badge">{downloads.length}</span>
        )}
      </button>

      {/* 6. AI Copilot & Multi-Node Synthesis (✨ AI 协同 ▾) */}
      <span className="jm-sel-bar__sep" aria-hidden="true" />
      <div className="jm-sel-bar__menu-wrap">
        <button
          type="button"
          className={`jm-sel-bar__btn jm-sel-bar__btn--ai${openMenu === "ai" ? " jm-sel-bar__btn--active" : ""}`}
          onClick={() => setOpenMenu((m) => (m === "ai" ? null : "ai"))}
          disabled={aiBusy}
          aria-expanded={openMenu === "ai"}
          aria-haspopup="menu"
          title="将框选的多个节点交给 AI 融合生成或智能分析编排"
        >
          <IconSparkle />
          <span>{aiBusy ? "连接中…" : "AI 协同"}</span>
          <span className="jm-sel-bar__caret" aria-hidden="true">⌄</span>
        </button>

        {openMenu === "ai" && (
          <div className="jm-sel-popover jm-sel-popover--ai" role="menu" aria-label="框选节点 AI 协同">
            <div className="jm-sel-popover__label">一键汇合连线生成</div>
            <button
              type="button"
              role="menuitem"
              className="jm-sel-popover__item"
              onClick={() => void handleAiSynthesizeNode("image")}
            >
              <span>🖼️ 融合所选生成新图片</span>
              <span className="jm-sel-popover__hint">自动连线</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="jm-sel-popover__item"
              onClick={() => void handleAiSynthesizeNode("video")}
            >
              <span>🎬 串联所选生成视频</span>
              <span className="jm-sel-popover__hint">参考/首尾帧</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="jm-sel-popover__item"
              onClick={() => void handleAiSynthesizeNode("Storyboard")}
            >
              <span>🎞️ 串联生成多格故事板</span>
              <span className="jm-sel-popover__hint">自动连线</span>
            </button>

            <div className="jm-sel-popover__divider" />
            <div className="jm-sel-popover__label">交给 AI 导演助手</div>
            <button
              type="button"
              role="menuitem"
              className="jm-sel-popover__item"
              onClick={() =>
                handleOpenAiChat(
                  "analyze",
                  `请综合拆解这 ${selectedNodes.length} 个选中节点的画面构图、角色外观一致性、光影色调与核心卖点。`,
                )
              }
            >
              <span>🔍 AI 批量拆解构图与画风</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="jm-sel-popover__item"
              onClick={() =>
                handleOpenAiChat(
                  "analyze",
                  `请融合这 ${selectedNodes.length} 个选中节点的主体特征与风格线索，提炼一段可直接用于 Flow 生图/生视频的高还原中文提示词。`,
                )
              }
            >
              <span>✨ AI 提炼统一融合提示词</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="jm-sel-popover__item"
              onClick={() =>
                handleOpenAiChat(
                  "create",
                  `请基于这 ${selectedNodes.length} 个选中节点，在画布右侧规划并搭建后续连贯分镜与视频续拍工作流。`,
                )
              }
            >
              <span>🎬 AI 规划多镜续拍工作流</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="jm-sel-popover__item"
              onClick={() => handleOpenAiChat("create", "")}
            >
              <span>💬 带所选节点自由问 AI…</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
