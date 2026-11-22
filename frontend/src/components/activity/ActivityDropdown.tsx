import { useEffect, useRef } from "react";
import type { ActivityListItem } from "../../api/client";
import { ActivityRow } from "./ActivityRow";

interface ActivityDropdownProps {
  items: ActivityListItem[];
  loading: boolean;
  nextBeforeId: number | null;
  onLoadMore(): void;
  onClose(): void;
  onSelect(id: number): void;
  onCancel?(id: number): Promise<void>;
}

export function ActivityDropdown({
  items,
  loading,
  nextBeforeId,
  onLoadMore,
  onClose,
  onSelect,
  onCancel,
}: ActivityDropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={panelRef} className="activity-dropdown" role="dialog" aria-label="任务与历史记录">
      <div className="activity-dropdown__header">
        <span className="activity-dropdown__title">任务与历史记录</span>
        <span className="activity-dropdown__count">
          共 {items.length} 条
        </span>
        <button
          type="button"
          className="activity-dropdown__close"
          onClick={onClose}
          aria-label="关闭任务列表"
        >
          ✕
        </button>
      </div>

      <div className="activity-dropdown__list">
        {loading && items.length === 0 && (
          <div className="activity-dropdown__placeholder">正在加载记录…</div>
        )}
        {!loading && items.length === 0 && (
          <div className="activity-dropdown__placeholder">
            暂无生成或解析记录。发起生图、生视频或智能提示词后将在此实时显示。
          </div>
        )}
        {items.map((item) => (
          <ActivityRow
            key={item.id}
            item={item}
            onClick={() => onSelect(item.id)}
            onCancel={onCancel}
          />
        ))}
      </div>

      {nextBeforeId !== null && (
        <button
          type="button"
          className="activity-dropdown__load-more"
          onClick={onLoadMore}
        >
          加载更早的 50 条记录
        </button>
      )}
    </div>
  );
}
