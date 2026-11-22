import { useEffect, useState } from "react";
import { getActivityDetail, type ActivityDetail } from "../../api/client";
import { formatDuration, metaFor, statusMeta } from "./activity-meta";

interface ActivityDetailModalProps {
  activityId: number | null;
  onClose(): void;
}

interface JsonSectionProps {
  label: string;
  data: unknown;
  startOpen?: boolean;
}

function JsonSection({ label, data, startOpen = false }: JsonSectionProps) {
  const [open, setOpen] = useState(startOpen);
  const [copied, setCopied] = useState(false);
  const isEmpty =
    data === null
    || data === undefined
    || (typeof data === "object" && data !== null && Object.keys(data).length === 0);
  const text = JSON.stringify(data ?? {}, null, 2);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }

  return (
    <div className={`activity-detail__section${open ? " activity-detail__section--open" : ""}`}>
      <div className="activity-detail__section-head">
        <button
          type="button"
          className="activity-detail__section-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="activity-detail__section-arrow" aria-hidden="true">
            {open ? "▼" : "▶"}
          </span>
          <span className="activity-detail__section-label">{label}</span>
          {isEmpty && (
            <span className="activity-detail__section-empty">（空）</span>
          )}
        </button>
        {!isEmpty && (
          <button
            type="button"
            className="activity-detail__copy-btn"
            onClick={handleCopy}
          >
            {copied ? "✓ 已复制" : "复制"}
          </button>
        )}
      </div>
      {open && !isEmpty && (
        <pre className="activity-detail__json">{text}</pre>
      )}
    </div>
  );
}

export function ActivityDetailModal({ activityId, onClose }: ActivityDetailModalProps) {
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activityId === null) return;
    setDetail(null);
    setError(null);
    let alive = true;
    getActivityDetail(activityId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [activityId]);

  useEffect(() => {
    if (activityId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activityId, onClose]);

  if (activityId === null) return null;

  return (
    <div
      className="activity-detail-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="activity-detail" role="dialog" aria-modal="true">
        <div className="activity-detail__header">
          <span className="activity-detail__title">
            {detail
              ? `任务记录 #${detail.id} — ${metaFor(detail.type).label}`
              : "正在加载详情…"}
          </span>
          <button
            type="button"
            className="activity-detail__close"
            onClick={onClose}
            aria-label="关闭详情"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="activity-detail__error" role="alert">
            ⚠ 读取失败：{error}
          </div>
        )}

        {detail && (
          <>
            <dl className="activity-detail__meta">
              <dt>状态</dt>
              <dd>
                <span
                  className={`activity-detail__status activity-detail__status--${
                    statusMeta(detail.status).tone
                  }`}
                >
                  {statusMeta(detail.status).icon} {statusMeta(detail.status).label}
                </span>
              </dd>
              {detail.node_short_id && (
                <>
                  <dt>关联节点</dt>
                  <dd>#{detail.node_short_id}</dd>
                </>
              )}
              <dt>开始时间</dt>
              <dd>{detail.created_at}</dd>
              {detail.finished_at && (
                <>
                  <dt>结束时间</dt>
                  <dd>
                    {detail.finished_at}
                    {detail.duration_ms !== null && (
                      <span className="activity-detail__dur">
                        （{formatDuration(detail.duration_ms)}）
                      </span>
                    )}
                  </dd>
                </>
              )}
            </dl>

            <JsonSection
              label="输入参数"
              data={detail.params}
              startOpen={detail.status !== "failed"}
            />
            <JsonSection
              label="返回结果"
              data={detail.result}
              startOpen={detail.status === "done"}
            />
            <div
              className={`activity-detail__section${
                detail.error ? " activity-detail__section--open" : ""
              }`}
            >
              <div className="activity-detail__section-toggle">
                <span className="activity-detail__section-arrow" aria-hidden="true">
                  {detail.error ? "▼" : "▶"}
                </span>
                <span className="activity-detail__section-label">错误信息</span>
                {!detail.error && (
                  <span className="activity-detail__section-empty">（无）</span>
                )}
              </div>
              {detail.error && (
                <pre className="activity-detail__error-text">{detail.error}</pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
