import { useEffect, useRef, useState } from "react";
import { MiniMap, useReactFlow, useViewport } from "@xyflow/react";
import {
  IconEdgesToggle,
  IconFitView,
  IconMiniMap,
  IconPlaySequence,
} from "../components/JimengIcons";

interface ViewportCapsuleProps {
  edgesHidden: boolean;
  onToggleEdges(): void;
  onOpenSequence(): void;
  interactionMode: "select" | "hand";
  onChangeInteractionMode(mode: "select" | "hand"): void;
  snapEnabled: boolean;
  onToggleSnap(): void;
}

const ZOOM_PRESETS = [
  { label: "50%", value: 0.5 },
  { label: "100%", value: 1 },
  { label: "150%", value: 1.5 },
  { label: "200%", value: 2 },
] as const;

/**
 * 即梦风格左下角极简视口控制胶囊：
 * 支持：↖ 框选模式(V) · ✋ 抓手平移(H) · ▷ 全局序列预览 · ⊡ 迷你小地图 · ☍ 连线显隐 · 🧲 辅助对齐 · 缩放预设。
 */
export function ViewportCapsule({
  edgesHidden,
  onToggleEdges,
  onOpenSequence,
  interactionMode,
  onChangeInteractionMode,
  snapEnabled,
  onToggleSnap,
}: ViewportCapsuleProps) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const zoomWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!zoomMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (zoomWrapRef.current && !zoomWrapRef.current.contains(e.target as Node)) {
        setZoomMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [zoomMenuOpen]);

  const zoomPct = Math.round(zoom * 100);

  return (
    <>
      {miniMapOpen && (
        <div className="jm-minimap-wrap">
          <MiniMap
            pannable
            zoomable
            bgColor="rgba(20, 20, 24, 0.9)"
            maskColor="rgba(9, 9, 11, 0.65)"
            nodeColor="rgba(255, 255, 255, 0.18)"
            nodeStrokeColor="rgba(56, 189, 248, 0.45)"
          />
        </div>
      )}

      <div className="jm-viewport-bar" role="toolbar" aria-label="画布视口控制">
        <button
          type="button"
          className={`jm-viewport-bar__btn${interactionMode === "select" ? " jm-viewport-bar__btn--active" : ""}`}
          onClick={() => onChangeInteractionMode("select")}
          title="选择与框选模式 (V)：左键空白处拖拽框选多节点；按住空格或中键/右键拖动画布"
          aria-label="选择与框选模式 (V)"
          aria-pressed={interactionMode === "select"}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 3.5 15.5 10l-4.8 1.2L8.8 16 5 3.5Z" />
          </svg>
        </button>

        <button
          type="button"
          className={`jm-viewport-bar__btn${interactionMode === "hand" ? " jm-viewport-bar__btn--active" : ""}`}
          onClick={() => onChangeInteractionMode("hand")}
          title="抓手平移模式 (H)：左键拖动画布；按住 Shift + 左键仍可框选"
          aria-label="抓手平移模式 (H)"
          aria-pressed={interactionMode === "hand"}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8.5 9.5V4.8a1.1 1.1 0 1 1 2.2 0v4.2m0-3.2a1.1 1.1 0 1 1 2.2 0v3.8m0-2.4a1.1 1.1 0 1 1 2.2 0v4.3a5 5 0 0 1-5 5H9.2a4.6 4.6 0 0 1-4.1-2.5L3.6 11a1.1 1.1 0 0 1 1.9-1.1l1.2 1.8V6.2a1.1 1.1 0 1 1 1.8 0" />
          </svg>
        </button>

        <span className="jm-viewport-bar__sep" aria-hidden="true" />

        <button
          type="button"
          className="jm-viewport-bar__btn"
          onClick={onOpenSequence}
          title="时间线序列预览"
          aria-label="打开时间线序列预览"
        >
          <IconPlaySequence size={14} />
        </button>

        <button
          type="button"
          className={`jm-viewport-bar__btn${miniMapOpen ? " jm-viewport-bar__btn--active" : ""}`}
          onClick={() => setMiniMapOpen((v) => !v)}
          title={miniMapOpen ? "隐藏导航小地图" : "展开导航小地图"}
          aria-label="切换导航小地图"
          aria-pressed={miniMapOpen}
        >
          <IconMiniMap size={14} />
        </button>

        <button
          type="button"
          className={`jm-viewport-bar__btn${edgesHidden ? " jm-viewport-bar__btn--active" : ""}`}
          onClick={onToggleEdges}
          title={edgesHidden ? "显示节点连线" : "隐藏节点连线"}
          aria-label="切换节点连线显隐"
          aria-pressed={edgesHidden}
        >
          <IconEdgesToggle size={14} />
        </button>

        <button
          type="button"
          className={`jm-viewport-bar__btn${snapEnabled ? " jm-viewport-bar__btn--active" : ""}`}
          onClick={onToggleSnap}
          title={
            snapEnabled
              ? "辅助对齐吸附：已开启（拖拽不同模块自动吸附并显示蓝虚线；按住 Alt 临时自由移动）"
              : "辅助对齐吸附：已关闭（点击开启跨模块智能对齐线）"
          }
          aria-label="切换辅助对齐线与吸附"
          aria-pressed={snapEnabled}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2.5" y="5" width="4.5" height="10" rx="1.2" />
            <rect x="13" y="5" width="4.5" height="10" rx="1.2" />
            <path d="M7.5 5h5M7.5 10h5M7.5 15h5" strokeDasharray="1.8 1.8" />
          </svg>
        </button>

        <span className="jm-viewport-bar__sep" aria-hidden="true" />

        <button
          type="button"
          className="jm-viewport-bar__btn jm-viewport-bar__btn--step"
          onClick={() => void zoomOut({ duration: 160 })}
          title="缩小"
          aria-label="缩小"
        >
          −
        </button>

        <div ref={zoomWrapRef} className="jm-zoom-wrap">
          <button
            type="button"
            className="jm-viewport-bar__zoom"
            onClick={() => setZoomMenuOpen((v) => !v)}
            title="点击切换缩放比例或适应画布"
            aria-label={`当前缩放 ${zoomPct}%，点击选择缩放比例`}
            aria-expanded={zoomMenuOpen}
            aria-haspopup="menu"
          >
            {zoomPct}%
          </button>

          {zoomMenuOpen && (
            <div className="jm-zoom-popover" role="menu" aria-label="缩放预设">
              {ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  role="menuitem"
                  className="jm-zoom-popover__item"
                  onClick={() => {
                    void zoomTo(preset.value, { duration: 200 });
                    setZoomMenuOpen(false);
                  }}
                >
                  <span>{preset.label}</span>
                  {Math.abs(zoom - preset.value) < 0.05 && (
                    <span className="jm-zoom-popover__check" aria-hidden="true">✓</span>
                  )}
                </button>
              ))}
              <div className="jm-zoom-popover__divider" />
              <button
                type="button"
                role="menuitem"
                className="jm-zoom-popover__item"
                onClick={() => {
                  void fitView({ duration: 260, padding: 0.2 });
                  setZoomMenuOpen(false);
                }}
              >
                <IconFitView size={13} />
                <span>适应画布</span>
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="jm-viewport-bar__btn jm-viewport-bar__btn--step"
          onClick={() => void zoomIn({ duration: 160 })}
          title="放大"
          aria-label="放大"
        >
          +
        </button>
      </div>
    </>
  );
}
