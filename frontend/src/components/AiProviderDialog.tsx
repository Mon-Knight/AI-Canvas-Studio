import { useEffect, useRef } from "react";
import { AiProvidersSection } from "./settings/AiProvidersSection";

interface AiProviderDialogProps {
  open: boolean;
  onClose(): void;
  /** 为 true 时隐藏关闭按钮并禁用背景/ESC 关闭（用于首次引导门禁） */
  force?: boolean;
}

export function AiProviderDialog({ open, onClose, force = false }: AiProviderDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || force) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, force]);

  if (!open) return null;

  return (
    <div
      className={`ai-provider-dialog-backdrop${force ? " ai-provider-dialog-backdrop--force" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (force) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="ai-provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI 模型与提供商配置"
      >
        <div className="ai-provider-dialog__header">
          <span className="ai-provider-dialog__title">
            {force ? "初始化 AI 模型提供商" : "AI 模型与提供商"}
          </span>
          {!force && (
            <button
              type="button"
              className="ai-provider-dialog__close"
              onClick={onClose}
              aria-label="关闭窗口"
            >
              ✕
            </button>
          )}
        </div>
        {force && (
          <div className="ai-provider-dialog__force-banner" role="alert">
            开始创作前，请先为「智能提示词」、「视觉解析」与「分镜规划」分别指定可用的本地 AI 模型提供商（具体模型与推理强度可保持默认），然后点击「保存配置」继续。
          </div>
        )}
        <AiProvidersSection />
      </div>
    </div>
  );
}
