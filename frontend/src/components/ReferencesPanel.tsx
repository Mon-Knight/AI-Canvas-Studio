import { useEffect, useMemo, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { mediaUrl, type ReferenceItem } from "../api/client";
import { displayBoardName, displayNodeTitle } from "../constants/nodeLabels";
import { useBoardStore } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { collectOccupiedBoxes, findFreeCanvasPosition, type CanvasBox } from "../lib/canvasLayout";
import { filterReferences, useReferencesStore } from "../store/references";
import { IconFilter, IconSearch, IconSortOrder } from "./JimengIcons";

type AssetSubTab = "all" | "image" | "video" | "audio" | "storyboard_shot";

/**
 * 即梦风格居中大圆角「资产库」模态框（参考图 03-asset-library-modal.png）：
 * - 一级胶囊切换：[资产] · [主体] · [画布]
 * - 二级分类标签 + 搜索框 + 排序/筛选按钮
 * - 6 列等比圆角卡片网格 + 左上角复选框支持批量多选上画布
 * - 底部统计「已选择 N 个素材」+ 右侧「确认」主按钮
 */
export function ReferencesPanel() {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const items = useReferencesStore((s) => s.items);
  const loading = useReferencesStore((s) => s.loading);
  const error = useReferencesStore((s) => s.error);
  const panelOpen = useReferencesStore((s) => s.panelOpen);
  const primaryTab = useReferencesStore((s) => s.activeTab);
  const setPrimaryTab = useReferencesStore((s) => s.setActiveTab);
  const query = useReferencesStore((s) => s.query);
  const setQuery = useReferencesStore((s) => s.setQuery);
  const setPanelOpen = useReferencesStore((s) => s.setPanelOpen);
  const remove = useReferencesStore((s) => s.remove);
  const togglePin = useReferencesStore((s) => s.togglePin);

  const boards = useBoardStore((s) => s.boards);
  const boardNodes = useBoardStore((s) => s.nodes);
  const setNodes = useBoardStore((s) => s.setNodes);
  const activeBoardId = useBoardStore((s) => s.boardId);
  const switchBoard = useBoardStore((s) => s.switchBoard);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);

  const [subTab, setSubTab] = useState<AssetSubTab>("all");
  const [sortAsc, setSortAsc] = useState(false);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmBusy, setConfirmBusy] = useState(false);

  // 关闭时清空多选状态，支持 ESC 关闭
  useEffect(() => {
    if (!panelOpen) {
      setSelectedIds(new Set());
      return;
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [panelOpen, setPanelOpen]);

  const filtered = useMemo(() => {
    let list = filterReferences(items, query);
    if (pinnedOnly) {
      list = list.filter((item) => item.pinned);
    }
    if (primaryTab === "subjects") {
      list = list.filter(
        (item) => item.kind === "character" || item.kind === "visual_asset",
      );
    } else if (subTab === "image") {
      list = list.filter((item) => item.kind === "image" || item.kind === "visual_asset");
    } else if (subTab === "audio") {
      list = list.filter((item) => item.kind === "audio");
    } else if (subTab === "storyboard_shot") {
      list = list.filter((item) => item.kind === "storyboard_shot");
    }
    if (sortAsc) {
      return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return list;
  }, [items, query, primaryTab, subTab, pinnedOnly, sortAsc]);

  const videoClips = useMemo(() => {
    if (primaryTab !== "assets" || subTab !== "video") return [];
    const needle = query.trim().toLowerCase();
    const clips: Array<{
      key: string;
      rfId: string;
      shortId: string;
      title: string;
      prompt: string;
      mediaId: string;
      variantIdx: number;
    }> = [];
    for (const node of boardNodes) {
      if (node.data.type !== "video") continue;
      const fromArray = (node.data.mediaIds ?? []).filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      );
      const list = fromArray.length > 0
        ? fromArray
        : (typeof node.data.mediaId === "string" && node.data.mediaId ? [node.data.mediaId] : []);
      if (list.length === 0) continue;
      const title = displayNodeTitle(node.data.title, node.data.type);
      const prompt = node.data.prompt ?? "";
      if (
        needle
        && !title.toLowerCase().includes(needle)
        && !node.data.shortId.toLowerCase().includes(needle)
        && !prompt.toLowerCase().includes(needle)
      ) {
        continue;
      }
      list.forEach((mediaId, idx) => {
        clips.push({
          key: `${node.id}-${idx}-${mediaId}`,
          rfId: node.id,
          shortId: node.data.shortId,
          title,
          prompt,
          mediaId,
          variantIdx: idx,
        });
      });
    }
    return sortAsc ? clips.reverse() : clips;
  }, [boardNodes, primaryTab, subTab, query, sortAsc]);

  if (!panelOpen) return null;

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function spawnItemsToCanvas(list: ReferenceItem[]) {
    if (list.length === 0 || confirmBusy) return;
    setConfirmBusy(true);
    try {
      const center = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const cols = Math.min(3, list.length);
      const batchBoxes: CanvasBox[] = [];
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const preferred = {
          x: center.x - 128 + (col - (cols - 1) / 2) * 296,
          y: center.y - 160 + row * 360,
        };
        const occupied = collectOccupiedBoxes(useBoardStore.getState().nodes, batchBoxes, 256, 330);
        const pos = findFreeCanvasPosition({
          origin: preferred,
          occupied,
          width: 256,
          height: 330,
          stepX: 296,
          stepY: 360,
        });
        batchBoxes.push({ x: pos.x, y: pos.y, width: 256, height: 330 });
        await useBoardStore.getState().addReferenceNode(
          {
            mediaId: item.mediaId,
            aiBrief: item.aiBrief,
            aspectRatio: item.aspectRatio,
            kind: item.kind,
            label: item.label,
          },
          pos,
        );
      }
      setSelectedIds(new Set());
      setPanelOpen(false);
    } finally {
      setConfirmBusy(false);
    }
  }

  async function handleConfirmSelection() {
    const chosen = items.filter((it) => selectedIds.has(it.id));
    await spawnItemsToCanvas(chosen);
  }

  return (
    <div
      className="jm-asset-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) setPanelOpen(false);
      }}
    >
      <div
        className="jm-asset-modal"
        role="dialog"
        aria-modal="true"
        aria-label="资产库"
      >
        {/* 一级胶囊切换 + 关闭按钮 */}
        <div className="jm-asset-modal__top">
          <div className="jm-asset-modal__pills" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={primaryTab === "assets"}
              className={`jm-asset-modal__pill${primaryTab === "assets" ? " jm-asset-modal__pill--active" : ""}`}
              onClick={() => setPrimaryTab("assets")}
            >
              资产
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={primaryTab === "subjects"}
              className={`jm-asset-modal__pill${primaryTab === "subjects" ? " jm-asset-modal__pill--active" : ""}`}
              onClick={() => setPrimaryTab("subjects")}
            >
              主体
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={primaryTab === "boards"}
              className={`jm-asset-modal__pill${primaryTab === "boards" ? " jm-asset-modal__pill--active" : ""}`}
              onClick={() => setPrimaryTab("boards")}
            >
              画布
            </button>
          </div>

          <button
            type="button"
            className="jm-asset-modal__close"
            onClick={() => setPanelOpen(false)}
            aria-label="关闭资产库"
          >
            ✕
          </button>
        </div>

        {primaryTab !== "boards" ? (
          <>
            {/* 二级分类标签 + 搜索栏 */}
            <div className="jm-asset-modal__subbar">
              <div className="jm-asset-modal__subtabs">
                {primaryTab === "assets" ? (
                  <>
                    <button
                      type="button"
                      className={`jm-asset-modal__subtab${subTab === "all" ? " jm-asset-modal__subtab--active" : ""}`}
                      onClick={() => setSubTab("all")}
                    >
                      全部
                    </button>
                    <button
                      type="button"
                      className={`jm-asset-modal__subtab${subTab === "image" ? " jm-asset-modal__subtab--active" : ""}`}
                      onClick={() => setSubTab("image")}
                    >
                      图片
                    </button>
                    <button
                      type="button"
                      className={`jm-asset-modal__subtab${subTab === "video" ? " jm-asset-modal__subtab--active" : ""}`}
                      onClick={() => setSubTab("video")}
                    >
                      视频
                    </button>
                    <button
                      type="button"
                      className={`jm-asset-modal__subtab${subTab === "audio" ? " jm-asset-modal__subtab--active" : ""}`}
                      onClick={() => setSubTab("audio")}
                    >
                      音频
                    </button>
                    <button
                      type="button"
                      className={`jm-asset-modal__subtab${subTab === "storyboard_shot" ? " jm-asset-modal__subtab--active" : ""}`}
                      onClick={() => setSubTab("storyboard_shot")}
                    >
                      分镜
                    </button>
                  </>
                ) : (
                  <span className="jm-asset-modal__sub-hint">
                    已沉淀的角色与核心物品锚点，跨画布保持画面主体一致性
                  </span>
                )}
              </div>

              <div className="jm-asset-modal__tools">
                <div className="jm-asset-modal__search">
                  <IconSearch size={14} />
                  <input
                    type="text"
                    placeholder="搜索素材描述或标签…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="搜索资产"
                  />
                </div>
                <button
                  type="button"
                  className={`jm-asset-modal__tool-btn${sortAsc ? " jm-asset-modal__tool-btn--active" : ""}`}
                  onClick={() => setSortAsc((v) => !v)}
                  title={sortAsc ? "当前：最早优先（点击切换最新优先）" : "当前：最新优先（点击切换最早优先）"}
                  aria-label="切换排序方式"
                  aria-pressed={sortAsc}
                >
                  <IconSortOrder size={15} />
                </button>
                <button
                  type="button"
                  className={`jm-asset-modal__tool-btn${pinnedOnly ? " jm-asset-modal__tool-btn--active" : ""}`}
                  onClick={() => setPinnedOnly((v) => !v)}
                  title={pinnedOnly ? "显示全部素材" : "仅查看已置顶素材"}
                  aria-label="仅看置顶筛选"
                  aria-pressed={pinnedOnly}
                >
                  <IconFilter size={15} />
                </button>
              </div>
            </div>

            {error && <div className="references-panel__error">{error}</div>}

            {/* 6 列正方形网格区 */}
            <div className="jm-asset-modal__body">
              {primaryTab === "assets" && subTab === "video" ? (
                videoClips.length === 0 ? (
                  <div className="jm-asset-modal__empty">
                    {query.trim()
                      ? `未找到与 "${query}" 匹配的视频成片。`
                      : "当前画布暂无已生成的视频成片。"}
                  </div>
                ) : (
                  <div className="jm-asset-grid">
                    {videoClips.map((clip) => (
                      <button
                        key={clip.key}
                        type="button"
                        className="jm-asset-tile jm-asset-tile--video"
                        onClick={() => {
                          setNodes(
                            boardNodes.map((n) => ({
                              ...n,
                              selected: n.id === clip.rfId,
                            })),
                          );
                          setPanelOpen(false);
                          void fitView({ nodes: [{ id: clip.rfId }], duration: 300, padding: 0.5 });
                          useGenerationStore.getState().openResultViewer(clip.rfId, clip.variantIdx);
                        }}
                        title={`${clip.title} #${clip.shortId}${clip.prompt ? `\n\n${clip.prompt}` : ""}\n（点击定位并预览视频）`}
                      >
                        <video
                          src={mediaUrl(clip.mediaId)}
                          preload="metadata"
                          muted
                          playsInline
                        />
                        <span className="jm-asset-tile__video-badge" aria-hidden="true">▶ 视频</span>
                        <div className="jm-asset-tile__caption" style={{ opacity: 1 }}>
                          <span>{clip.title} #{clip.shortId}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : loading && items.length === 0 ? (
                <div className="jm-asset-modal__empty">正在读取资产库…</div>
              ) : filtered.length === 0 ? (
                <div className="jm-asset-modal__empty">
                  {items.length === 0
                    ? "暂无收藏素材。在任意画布图片或主体节点上点击「★ 收藏」即可沉淀至此。"
                    : pinnedOnly
                      ? "暂无符合条件且已置顶的素材。"
                      : `未找到与 "${query}" 匹配的素材。`}
                </div>
              ) : (
                <div className="jm-asset-grid">
                  {filtered.map((item) => (
                    <AssetGridTile
                      key={item.id}
                      item={item}
                      checked={selectedIds.has(item.id)}
                      onToggle={() => toggleSelect(item.id)}
                      onDoubleClick={() => void spawnItemsToCanvas([item])}
                      onTogglePin={() => void togglePin(item.id)}
                      onDelete={() => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          next.delete(item.id);
                          return next;
                        });
                        void remove(item.id);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* 底部结算栏 */}
            <div className="jm-asset-modal__footer">
              <span className="jm-asset-modal__count">
                {primaryTab === "assets" && subTab === "video"
                  ? `当前画布共 ${videoClips.length} 条视频成片（点击卡片预览）`
                  : `已选择 ${selectedIds.size} 个素材`}
              </span>
              <button
                type="button"
                className="jm-asset-modal__confirm"
                disabled={
                  (primaryTab === "assets" && subTab === "video")
                  || selectedIds.size === 0
                  || confirmBusy
                }
                onClick={() => void handleConfirmSelection()}
              >
                {confirmBusy ? "正在导入…" : "确认"}
              </button>
            </div>
          </>
        ) : (
          /* 画布项目管理网格 */
          <div className="jm-asset-modal__body">
            <div className="jm-boards-grid">
              <button
                type="button"
                className="jm-board-card jm-board-card--new"
                onClick={async () => {
                  await createNewBoard("未命名项目");
                  setPanelOpen(false);
                }}
              >
                <span className="jm-board-card__plus">＋</span>
                <span className="jm-board-card__title">新建画布项目</span>
              </button>

              {boards.map((b) => {
                const isActive = b.id === activeBoardId;
                return (
                  <button
                    key={b.id}
                    type="button"
                    className={`jm-board-card${isActive ? " jm-board-card--active" : ""}`}
                    onClick={async () => {
                      await switchBoard(b.id);
                      setPanelOpen(false);
                    }}
                  >
                    <div className="jm-board-card__preview">
                      <span className="jm-board-card__badge">
                        {isActive ? "当前画布" : `#${b.id}`}
                      </span>
                    </div>
                    <span className="jm-board-card__title">
                      {displayBoardName(b.name)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AssetGridTile({
  item,
  checked,
  onToggle,
  onDoubleClick,
  onTogglePin,
  onDelete,
}: {
  item: ReferenceItem;
  checked: boolean;
  onToggle(): void;
  onDoubleClick(): void;
  onTogglePin(): void;
  onDelete(): void;
}) {
  const [broken, setBroken] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  function handleDragStart(e: React.DragEvent<HTMLDivElement>) {
    e.dataTransfer.setData(
      "application/x-flowboard-reference",
      JSON.stringify({
        mediaId: item.mediaId,
        aiBrief: item.aiBrief,
        aspectRatio: item.aspectRatio,
        kind: item.kind,
        label: item.label,
      }),
    );
    e.dataTransfer.effectAllowed = "copy";
  }

  const isAudio = item.kind === "audio";

  return (
    <div
      className={`jm-asset-tile${isAudio ? " jm-asset-tile--audio" : ""}${checked ? " jm-asset-tile--checked" : ""}`}
      draggable
      onDragStart={handleDragStart}
      onClick={onToggle}
      onDoubleClick={onDoubleClick}
      title={`${item.label}${item.aiBrief ? `\n\n${item.aiBrief}` : ""}\n（单击勾选 · 双击或拖拽直接上画布）`}
    >
      {isAudio ? (
        <div className="jm-asset-tile__audio-box" onClick={(e) => e.stopPropagation()}>
          <span className="jm-asset-tile__audio-icon" aria-hidden="true">ılı</span>
          <audio
            className="jm-asset-tile__audio-player"
            src={mediaUrl(item.mediaId)}
            controls
            preload="none"
          />
        </div>
      ) : !broken ? (
        <img
          src={mediaUrl(item.mediaId)}
          alt={item.label}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="jm-asset-tile__broken">素材预览</span>
      )}

      {/* 左上角即梦同款圆角复选框 */}
      <span
        className={`jm-asset-tile__checkbox${checked ? " jm-asset-tile__checkbox--on" : ""}`}
        aria-hidden="true"
      >
        {checked ? "✓" : ""}
      </span>

      {/* 右上角悬停操作：置顶与删除 */}
      <div
        className="jm-asset-tile__actions"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={`jm-asset-tile__act${item.pinned ? " jm-asset-tile__act--pinned" : ""}`}
          onClick={onTogglePin}
          title={item.pinned ? "取消置顶" : "置顶素材"}
        >
          ★
        </button>
        <button
          type="button"
          className={`jm-asset-tile__act jm-asset-tile__act--del${confirmDel ? " jm-asset-tile__act--armed" : ""}`}
          onClick={() => {
            if (!confirmDel) {
              setConfirmDel(true);
              setTimeout(() => setConfirmDel(false), 2500);
              return;
            }
            onDelete();
          }}
          title={confirmDel ? "再次点击确认移除" : "移除素材"}
        >
          {confirmDel ? "删?" : "×"}
        </button>
      </div>

      <div className="jm-asset-tile__caption">
        <span>{item.label}</span>
      </div>
    </div>
  );
}
