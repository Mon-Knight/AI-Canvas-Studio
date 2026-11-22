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
}

const ZOOM_PRESETS = [
  { label: "50%", value: 0.5 },
  { label: "100%", value: 1 },
  { label: "150%", value: 1.5 },
  { label: "200%", value: 2 },
] as const;

/**
 * 即梦风格左下角极简视口控制胶囊：
 * 支持：▷ 全局序列预览 · ⊡ 迷你小地图开关 · ☍ 连线显隐切换 · 缩放步进与比例预设菜单。
 */
export function ViewportCapsule({
  edgesHidden,
  onToggleEdges,
  onOpenSequence,
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
