import { useViewport } from "@xyflow/react";
import type { SnapGuideLine } from "../lib/smartSnapGuides";
import "./SnapGuidesOverlay.css";

/**
 * 画布拖拽智能辅助对齐线浮层：
 * 以视口屏幕坐标绘制 1.25px 极光蓝虚线，确保在任意缩放比例下都保持锐利清晰。
 */
export function SnapGuidesOverlay({ guides }: { guides: readonly SnapGuideLine[] }) {
  const { x: vpX, y: vpY, zoom } = useViewport();

  if (guides.length === 0) return null;

  return (
    <svg className="jm-snap-guides" aria-hidden="true">
      {guides.map((g, idx) => {
        if (g.orientation === "h") {
          const y = Math.round(vpY + g.pos * zoom) + 0.5;
          const x1 = vpX + g.start * zoom;
          const x2 = vpX + g.end * zoom;
          return (
            <line
              key={`h-${idx}-${Math.round(g.pos)}`}
              className={`jm-snap-guides__line${g.kind === "center" ? " jm-snap-guides__line--center" : ""}`}
              x1={x1}
              y1={y}
              x2={x2}
              y2={y}
            />
          );
        }
        const x = Math.round(vpX + g.pos * zoom) + 0.5;
        const y1 = vpY + g.start * zoom;
        const y2 = vpY + g.end * zoom;
        return (
          <line
            key={`v-${idx}-${Math.round(g.pos)}`}
            className={`jm-snap-guides__line${g.kind === "center" ? " jm-snap-guides__line--center" : ""}`}
            x1={x}
            y1={y1}
            x2={x}
            y2={y2}
          />
        );
      })}
    </svg>
  );
}
