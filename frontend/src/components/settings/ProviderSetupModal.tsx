import { useEffect, useState } from "react";
import type { LLMProviderName } from "../../api/client";

interface ProviderSetupModalProps {
  provider: LLMProviderName;
  open: boolean;
  onClose(): void;
}

function CommandLine({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }
  return (
    <div className="setup-modal__cmd">
      <code className="setup-modal__cmd-text">{cmd}</code>
      <button
        type="button"
        className="setup-modal__copy"
        onClick={() => void handleCopy()}
        aria-label="复制命令"
      >
        {copied ? "✓ 已复制" : "复制"}
      </button>
    </div>
  );
}

export function ProviderSetupModal({ provider, open, onClose }: ProviderSetupModalProps) {
  const [openaiTab, setOpenaiTab] = useState<"cli" | "api">("cli");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="setup-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="setup-modal" role="dialog" aria-modal="true">
        <div className="setup-modal__header">
          <span className="setup-modal__title">{titleFor(provider)}</span>
          <button
            type="button"
            className="setup-modal__close"
            onClick={onClose}
            aria-label="关闭配置指引"
          >
            ✕
          </button>
        </div>

        {provider === "claude" && <ClaudeContent />}
        {provider === "gemini" && <GeminiContent />}
        {provider === "openai" && (
          <OpenAiContent tab={openaiTab} onTabChange={setOpenaiTab} />
        )}
        {provider === "muse" && <MuseContent />}

        <div className="setup-modal__footer">
          <a
            className="setup-modal__docs-link"
            href={docsLinkFor(provider)}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看 {labelFor(provider)} 官方文档 ↗
          </a>
          <button
            type="button"
            className="setup-modal__close-btn"
            onClick={onClose}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

function ClaudeContent() {
  return (
    <div className="setup-modal__body">
      <p>通过官方 Claude Code CLI 直接复用你的现有订阅，无需额外配置 API Key。</p>
      <ol className="setup-modal__steps">
        <li>
          <span className="setup-modal__step-label">1. 全局安装 CLI</span>
          <CommandLine cmd="npm install -g @anthropic-ai/claude-code" />
        </li>
        <li>
          <span className="setup-modal__step-label">2. 登录认证</span>
          <CommandLine cmd="claude" />
          <span className="setup-modal__step-hint">
            终端将自动唤起浏览器完成 OAuth 登录。
          </span>
        </li>
        <li>
          <span className="setup-modal__step-label">3. 验证版本</span>
          <CommandLine cmd="claude --version" />
        </li>
      </ol>
    </div>
  );
}

function GeminiContent() {
  return (
    <div className="setup-modal__body">
      <p>当前 Gemini 通道由本地 Antigravity CLI (<code>agy</code>) 驱动。</p>
      <ol className="setup-modal__steps">
        <li>
          <span className="setup-modal__step-label">1. 确认 CLI 已加入 PATH</span>
          <CommandLine cmd="agy --version" />
        </li>
        <li>
          <span className="setup-modal__step-label">2. 更新或检查模型列表</span>
          <CommandLine cmd="agy models" />
        </li>
      </ol>
    </div>
  );
}

function OpenAiContent({
  tab,
  onTabChange,
}: {
  tab: "cli" | "api";
  onTabChange(t: "cli" | "api"): void;
}) {
  return (
    <div className="setup-modal__body">
      <div className="setup-modal__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "cli"}
          className={`setup-modal__tab${tab === "cli" ? " setup-modal__tab--active" : ""}`}
          onClick={() => onTabChange("cli")}
        >
          Codex CLI（推荐）
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "api"}
          className={`setup-modal__tab${tab === "api" ? " setup-modal__tab--active" : ""}`}
          onClick={() => onTabChange("api")}
        >
          API Key 备用
        </button>
      </div>

      {tab === "cli" ? (
        <ol className="setup-modal__steps">
          <li>
            <span className="setup-modal__step-label">1. 安装 Codex CLI</span>
            <CommandLine cmd="npm install -g @openai/codex" />
          </li>
          <li>
            <span className="setup-modal__step-label">2. OAuth 登录</span>
            <CommandLine cmd="codex login" />
          </li>
          <li>
            <span className="setup-modal__step-label">3. 验证版本</span>
            <CommandLine cmd="codex --version" />
          </li>
        </ol>
      ) : (
        <p className="setup-modal__note">
          可直接在上方「AI 模型与提供商」设置页的「OpenAI 兼容接口」卡片中填写自定义 Base URL（兼容任意 OpenAI 中转站或本地 Ollama）与 API 密钥，也可写入本地 <code>~/.flowboard/secrets.json</code>。
        </p>
      )}
    </div>
  );
}

function MuseContent() {
  return (
    <div className="setup-modal__body">
      <p>Muse 支持通过本地 <strong>muse2api</strong> 网关或 <strong>Pax worker</strong> 接入：</p>
      <ol className="setup-modal__steps">
        <li>
          <span className="setup-modal__step-label">方式 A —— muse2api 网关</span>
          <CommandLine cmd="FLOWBOARD_MUSE2API_BASE=http://127.0.0.1:18610" />
          <CommandLine cmd="FLOWBOARD_MUSE2API_KEY=<MUSE2API_API_KEY>" />
          <span className="setup-modal__step-hint">
            写入仓库根目录 <code>.env</code> 后重启本地 Agent 服务即可。
          </span>
        </li>
        <li>
          <span className="setup-modal__step-label">方式 B —— Pax Worker</span>
          <CommandLine cmd="python agent/scripts/muse_worker.py --worker-id pax-1" />
        </li>
      </ol>
    </div>
  );
}

function titleFor(p: LLMProviderName): string {
  switch (p) {
    case "claude":
      return "Claude CLI 配置指引";
    case "gemini":
      return "Gemini (agy) 配置指引";
    case "openai_api":
      return "OpenAI API 密钥";
    case "openai":
      return "OpenAI Codex 配置指引";
    case "muse":
      return "Muse 接入指引";
  }
}

function labelFor(p: LLMProviderName): string {
  switch (p) {
    case "claude":
      return "Anthropic";
    case "gemini":
      return "Google Gemini";
    case "openai":
    case "openai_api":
      return "OpenAI";
    case "muse":
      return "Muse";
  }
}

function docsLinkFor(p: LLMProviderName): string {
  switch (p) {
    case "claude":
      return "https://docs.anthropic.com/en/docs/claude-code/quickstart";
    case "gemini":
      return "https://github.com/google/gemini-cli";
    case "openai":
    case "openai_api":
      return "https://platform.openai.com/docs/quickstart";
    case "muse":
      return "https://muse.ai";
  }
}
