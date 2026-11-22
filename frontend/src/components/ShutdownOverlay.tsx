import { useEffect } from "react";
import { useDesktopFlowStore } from "../store/desktopFlow";
import { useGenerationStore } from "../store/generation";
import { useShutdownStore } from "../store/shutdown";
import { IconPower } from "./JimengIcons";

/**
 * 即梦画布风格 · 本地服务安全关闭确认弹窗 & 极光收束关机过渡动画
 */
export function ShutdownOverlay() {
  const confirmOpen = useShutdownStore((s) => s.confirmOpen);
  const phase = useShutdownStore((s) => s.phase);
  const closeConfirm = useShutdownStore((s) => s.closeConfirm);
  const confirmAndShutdown = useShutdownStore((s) => s.confirmAndShutdown);

  const isDesktop = useDesktopFlowStore((s) => s.isDesktop);
  const runningCount = useGenerationStore((s) => Object.keys(s.active).length);

  useEffect(() => {
    if (!confirmOpen || phase !== "idle") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeConfirm();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmOpen, phase, closeConfirm]);

  const progressWidth = phase === "saving" ? "52%" : "100%";

  return (
    <>
      {confirmOpen && phase === "idle" && (
        <div
          className="jm-shutdown-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeConfirm();
          }}
        >
          <div
            className="jm-shutdown-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="jm-shutdown-title"
          >
            <div className="jm-shutdown-dialog__head">
              <span className="jm-shutdown-dialog__icon" aria-hidden="true">
                <IconPower size={18} />
              </span>
              <div>
                <h3 id="jm-shutdown-title">关闭本地服务</h3>
                <p>
                  {runningCount > 0
                    ? `当前仍有 ${runningCount} 个任务正在生成中，关闭服务将中断未完成的任务。是否确认立即关闭？`
                    : "将自动保存画布与账号会话状态，并安全退出所有后台服务进程。"}
                </p>
              </div>
            </div>

            <div className="jm-shutdown-dialog__actions">
              <button
                id="btn-cancel-shutdown"
                type="button"
                className="jm-shutdown-btn"
                onClick={closeConfirm}
              >
                取消
              </button>
              <button
                id="btn-confirm-shutdown"
                type="button"
                className="jm-shutdown-btn jm-shutdown-btn--danger"
                onClick={() => void confirmAndShutdown(isDesktop)}
              >
                确认关闭服务
              </button>
            </div>
          </div>
        </div>
      )}

      {phase !== "idle" && (
        <div
          className="jm-shutdown-curtain"
          data-phase={phase}
          role="status"
          aria-live="polite"
          aria-label="关闭服务进度动画"
        >
          <div className="jm-shutdown-stage">
            <div className={`jm-shutdown-orb jm-shutdown-orb--${phase}`} aria-hidden="true">
              <div className="jm-shutdown-orb__halo" />
              <div className="jm-shutdown-orb__ring" />
              <div className="jm-shutdown-orb__core">
                {phase === "completed" ? (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <IconPower size={24} />
                )}
              </div>
            </div>

            <h2 className="jm-shutdown-stage__title">
              {phase === "saving"
                ? "正在保存画布与会话状态…"
                : phase === "stopping"
                  ? "正在安全关闭本地引擎服务…"
                  : "本地服务已安全关闭"}
            </h2>

            <p className="jm-shutdown-stage__sub">
              {phase === "saving"
                ? "同步本地数据库与持久化配置"
                : phase === "stopping"
                  ? "释放桥接通道与后台守护进程"
                  : isDesktop
                    ? "所有守护进程已安全清理，桌面端即将自动退出。"
                    : "后台 FastAPI 与前端服务均已干净退出，现在可以直接关闭此页面。"}
            </p>

            <div className="jm-shutdown-progress" aria-hidden="true">
              <div
                className={`jm-shutdown-progress__fill${phase === "completed" ? " jm-shutdown-progress__fill--done" : ""}`}
                style={{ width: progressWidth }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
