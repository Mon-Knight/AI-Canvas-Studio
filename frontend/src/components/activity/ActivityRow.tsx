import { useState } from "react";
import type { ActivityListItem } from "../../api/client";
import { ActivityTypeIcon } from "./ActivityIcon";
import { formatDuration, metaFor, relativeTime, statusMeta } from "./activity-meta";

interface ActivityRowProps {
  item: ActivityListItem;
  onClick(): void;
  onCancel?(id: number): Promise<void>;
}

export function ActivityRow({ item, onClick, onCancel }: ActivityRowProps) {
  const meta = metaFor(item.type);
  const status = statusMeta(item.status);
  const node = item.node_short_id ? `· #${item.node_short_id}` : "";
  const dur = item.duration_ms !== null ? formatDuration(item.duration_ms) : "";
  const [busy, setBusy] = useState(false);
  const canCancel =
    (item.status === "queued" || item.status === "running") && !!onCancel;

  async function handleCancel(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onCancel || busy) return;
    setBusy(true);
    try {
      await onCancel(item.id);
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`activity-row activity-row--${status.tone}`}
      onClick={onClick}
      onKeyDown={onKey}
      title={`开始于 ${item.created_at}`}
    >
      <span
        className={`activity-row__icon activity-row__icon--${meta.group}`}
        aria-hidden="true"
      >
        <ActivityTypeIcon type={item.type} size={14} />
      </span>
      <div className="activity-row__body">
        <div className="activity-row__title">
          {meta.label} <span className="activity-row__node">{node}</span>
        </div>
        <div className="activity-row__meta">
          {relativeTime(item.created_at)}
          {dur &&
            (item.status === "done" ||
              item.status === "failed" ||
              item.status === "canceled" ||
              item.status === "timeout") && (
              <span className="activity-row__dur"> · 耗时 {dur}</span>
            )}
          {(item.status === "failed" || item.status === "timeout") && (
            <span className="activity-row__hint"> · 点击查看错误详情</span>
          )}
        </div>
      </div>
      <span className={`activity-row__status activity-row__status--${status.tone}`}>
        <span className="activity-row__status-icon" aria-hidden="true">
          {status.icon}
        </span>
        {status.label}
      </span>
      {canCancel && (
        <button
          type="button"
          className="activity-row__cancel"
          onClick={handleCancel}
          disabled={busy}
          aria-label={`取消 ${meta.label}`}
          title="取消任务"
        >
          {busy ? "…" : "取消"}
        </button>
      )}
    </div>
  );
}
