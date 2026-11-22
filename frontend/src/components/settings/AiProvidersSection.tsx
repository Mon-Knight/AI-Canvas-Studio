import { useCallback, useEffect, useRef, useState } from "react";
import {
  getLlmConfig,
  getLlmProviderModels,
  getLlmProviders,
  setLlmConfig,
  setLlmProviderCredentials,
  testLlmProvider,
  type LLMConfig,
  type LLMConfigUpdate,
  type LLMFeature,
  type LLMFeatureConfig,
  type LLMModelInfo,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../../api/client";
import { FeatureConfigRow, type FeatureTest } from "./FeatureConfigRow";
import { ProviderSetupModal } from "./ProviderSetupModal";

const REFRESH_INTERVAL_MS = 30_000;
// Order matters — this is the option order in every provider select.
// Gemini first (lowest install friction), Claude middle, Codex last.
const SHOWN_PROVIDERS: LLMProviderName[] = ["openai_api", "gemini", "claude", "openai", "muse"];
const FEATURES: LLMFeature[] = ["chat_agent", "auto_prompt", "vision", "planner"];

const FEATURE_META: Record<LLMFeature, { title: string; blurb: string }> = {
  chat_agent: {
    title: "对话与创作编排",
    blurb: "创意分析固定使用 OpenAI API。此处选择 OpenAI API 时可指定分析模型；其他提供商只用于编排，未指定则编排跟随分镜规划。",
  },
  auto_prompt: {
    title: "智能提示词 (Auto-Prompt)",
    blurb: "将简短创意与上游参考节点合成为完整生图/生视频提示词，调用频繁，建议优先选择响应速度快的模型。",
  },
  vision: {
    title: "视觉解析 (Vision)",
    blurb: "解析上传或生成的参考图内容并提取描述摘要，仅列出具备多模态识图能力的提供商。",
  },
  planner: {
    title: "分镜规划 (Planner)",
    blurb: "将创作目标拆解为多节点串联画布方案，调用低频，建议选择推理质量高的模型。",
  },
};

// Gemini is labelled with its CLI because the binary is `agy`, not
// `gemini` — users who go looking for the process need that hint.
const PROVIDER_LABEL: Record<LLMProviderName, string> = {
  claude: "Claude",
  gemini: "Gemini (agy)",
  openai: "OpenAI (Codex)",
  openai_api: "OpenAI 兼容接口（API Key / Base URL）",
  muse: "Muse",
};

const UNTESTED: FeatureTest = { state: "untested" };
const INITIAL_TESTS: Record<LLMFeature, FeatureTest> = {
  auto_prompt: UNTESTED,
  vision: UNTESTED,
  planner: UNTESTED,
  chat_agent: UNTESTED,
};

type Draft = Record<LLMFeature, LLMFeatureConfig>;

function draftFrom(config: LLMConfig): Draft {
  // Structural copy — the draft is mutated by the rows and must not
  // alias the fetched config (which `dirty` compares against).
  return {
    auto_prompt: { ...config.auto_prompt },
    vision: { ...config.vision },
    planner: { ...config.planner },
    chat_agent: { ...(config.chat_agent ?? { provider: null, model: null, effort: null }) },
  };
}

function sameFeature(a: LLMFeatureConfig, b: LLMFeatureConfig): boolean {
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

/** Effort default when the user switches providers. The backend has no
 * `defaultEffort` field, so we pick the middle of the road: "medium"
 * when the provider offers it, otherwise the first level it reports. */
function defaultEffortFor(p: LLMProviderInfo | undefined): string | null {
  if (!p || !p.supportsEffort || p.efforts.length === 0) return null;
  return p.efforts.includes("medium") ? "medium" : p.efforts[0];
}

export function AiProvidersSection() {
  const [providers, setProviders] = useState<LLMProviderInfo[] | null>(null);
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Local edits, seeded from /config (see the draft note in the header).
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tests, setTests] = useState<Record<LLMFeature, FeatureTest>>(INITIAL_TESTS);
  // Catalogs fetched via the ⟳ button, overlaid on top of whatever
  // GET /providers shipped. Keyed by provider so two features sharing a
  // provider share the refreshed list.
  const [catalogs, setCatalogs] = useState<
    Partial<Record<LLMProviderName, LLMModelInfo[]>>
  >({});
  // Tracked per provider rather than as one global flag: two rows on
  // different providers can refresh at the same time, and two rows on
  // the SAME provider must both show the spinner (they share a catalog).
  const [refreshingModels, setRefreshingModels] = useState<
    Partial<Record<LLMProviderName, boolean>>
  >({});
  const [applying, setApplying] = useState(false);
  const [helpFor, setHelpFor] = useState<LLMProviderName | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<LLMConfig | null> => {
    try {
      const [p, c] = await Promise.all([getLlmProviders(), getLlmConfig()]);
      if (!aliveRef.current) return null;
      setProviders(p);
      setConfig(c);
      setLoadError(null);
      return c;
    } catch (err) {
      if (!aliveRef.current) return null;
      setLoadError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  // Initial load + 30s polling, visibility-aware.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  // Seed the draft the first time /config lands. Guarded on
  // `draft === null` so later polls leave in-progress edits alone.
  useEffect(() => {
    if (draft !== null || config === null) return;
    setDraft(draftFrom(config));
  }, [config, draft]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  function patchFeature(feature: LLMFeature, patch: Partial<LLMFeatureConfig>) {
    setDraft((prev) => (prev ? { ...prev, [feature]: { ...prev[feature], ...patch } } : prev));
  }

  function handleProviderChange(feature: LLMFeature, name: LLMProviderName | null) {
    const info = providers?.find((p) => p.name === name);
    // Model + effort belong to the provider that offered them, so a
    // provider switch resets both to that provider's defaults rather
    // than carrying over an id the new CLI has never heard of.
    patchFeature(feature, {
      provider: name,
      model: info?.defaultModel ?? null,
      effort: defaultEffortFor(info),
    });
    // The previous test result was against a different target.
    setTests((prev) => ({ ...prev, [feature]: UNTESTED }));
  }

  function catalogFor(name: LLMProviderName | null): LLMModelInfo[] {
    if (!name) return [];
    return catalogs[name] ?? providers?.find((p) => p.name === name)?.models ?? [];
  }

  async function refreshModels(name: LLMProviderName) {
    if (refreshingModels[name]) return;
    setRefreshingModels((prev) => ({ ...prev, [name]: true }));
    try {
      const { models } = await getLlmProviderModels(name, true);
      if (!aliveRef.current) return;
      setCatalogs((prev) => ({ ...prev, [name]: models }));
      showToast(
        models.length > 0
          ? `${PROVIDER_LABEL[name]}: ${models.length} 个模型。`
          : `${PROVIDER_LABEL[name]} 暂无模型列表，请输入模型标识。`,
      );
    } catch (err) {
      showToast(
        `刷新模型失败： ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (aliveRef.current) {
        setRefreshingModels((prev) => ({ ...prev, [name]: false }));
      }
    }
  }

  async function runTest(feature: LLMFeature) {
    const pin = draft?.[feature];
    if (!pin?.provider) return;
    setTests((prev) => ({ ...prev, [feature]: { state: "testing" } }));
    // Tests carry the row's exact model + effort: a provider that
    // answers on its default model can still fail on an exotic one.
    const result = await testLlmProvider(pin.provider, {
      model: pin.model,
      effort: pin.effort,
    }).catch(() => ({ ok: false, error: "连接测试失败，请检查本地服务。", latencyMs: undefined }));
    if (!aliveRef.current) return;
    setTests((prev) => ({
      ...prev,
      [feature]: result.ok
        ? { state: "ok", latencyMs: result.latencyMs }
        : { state: "fail", error: result.error || "连通测试失败" },
    }));
  }

  async function handleApply() {
    if (!draft || applying) return;
    setApplying(true);
    try {
      const body: LLMConfigUpdate = {};
      for (const feature of FEATURES) {
        const pin = draft[feature];
        // A feature with no provider has nothing to pin — leave it out
        // rather than PUTting a null the backend would have to special
        // case. model/effort DO go out as null when unset: that's the
        // signal for "use the provider default", and omitting them
        // would leave a stale id from the previous provider in place.
        if (!pin.provider && (feature !== "chat_agent" || !config?.chat_agent?.provider)) continue;
        body[feature] = { provider: pin.provider, model: pin.model, effort: pin.effort };
      }
      await setLlmConfig(body);
      showToast("模型配置已保存。");
      const fresh = await refresh();
      if (fresh && aliveRef.current) setDraft(draftFrom(fresh));
      // Broadcast so the badge + ForcedSetupGate refresh immediately
      // instead of waiting up to 30s for their own poll. Plain window
      // event keeps the contract loose — anyone interested subscribes,
      // no shared store coupling.
      window.dispatchEvent(new CustomEvent("flowboard:llm-config-changed"));
    } catch (err) {
      showToast(
        `保存失败： ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (aliveRef.current) setApplying(false);
    }
  }

  // ── Render guards ───────────────────────────────────────────────

  if ((!providers || !config || !draft) && !loadError) {
    return (
      <div className="ai-providers-section">
        <div className="ai-providers-section__skeleton">
          <div className="ai-providers-section__skeleton-row ai-providers-section__skeleton-row--tall" />
          <div className="ai-providers-section__skeleton-row ai-providers-section__skeleton-row--tall" />
          <div className="ai-providers-section__skeleton-row ai-providers-section__skeleton-row--tall" />
        </div>
      </div>
    );
  }

  if (loadError && (!providers || !config || !draft)) {
    return (
      <div className="ai-providers-section">
        <div className="ai-providers-section__error" role="alert">
          暂未读取到模型配置。
          <button
            type="button"
            className="ai-providers-section__retry"
            onClick={() => void refresh()}
          >
            重试
          </button>
          <div className="ai-providers-section__error-detail">{loadError}</div>
        </div>
      </div>
    );
  }

  // Past this point providers / config / draft are all non-null.
  const allProviders = providers!;
  const currentDraft = draft!;
  const ordered = SHOWN_PROVIDERS.map((name) =>
    allProviders.find((p) => p.name === name),
  ).filter((p): p is LLMProviderInfo => p !== undefined);
  const visionCapable = ordered.filter((p) => p.supportsVision);

  const missing = FEATURES.filter((f) => f !== "chat_agent" && !currentDraft[f].provider);
  const dirty = FEATURES.some((f) => !sameFeature(currentDraft[f], (config![f] ?? {provider: null, model: null, effort: null})));

  return (
    <div className="ai-providers-section">
      <div className="ai-providers-section__intro">
        只使用对话时，选择「画布对话」的提供商即可。API 密钥保存在本机，模型调用由对应服务商计费。
      </div>

      {missing.length > 0 && (
        <div className="ai-providers-section__mixed-notice" role="alert">
          ⓘ 尚未配置的生成辅助能力：{missing.map((f) => FEATURE_META[f].title).join("、")}。这些能力可稍后配置。
        </div>
      )}

      <div className="feature-config-list">
        {FEATURES.map((feature) => {
          const pin = currentDraft[feature];
          const options = feature === "vision" ? visionCapable : ordered;
          const selected = pin.provider
            ? allProviders.find((p) => p.name === pin.provider) ?? null
            : null;
          return (
            <FeatureConfigRow
              key={feature}
              title={FEATURE_META[feature].title}
              blurb={FEATURE_META[feature].blurb}
              options={options}
              selected={selected}
              allowFallback={feature === "chat_agent"}
              value={pin}
              models={catalogFor(pin.provider)}
              modelsRefreshing={pin.provider ? refreshingModels[pin.provider] === true : false}
              test={tests[feature]}
              providerLabel={(name) => PROVIDER_LABEL[name]}
              onProviderChange={(name) => handleProviderChange(feature, name)}
              onPatch={(patch) => patchFeature(feature, patch)}
              onTest={() => void runTest(feature)}
              onRefreshModels={() => {
                if (pin.provider) void refreshModels(pin.provider);
              }}
              onSetupHelp={() => setHelpFor(pin.provider)}
            />
          );
        })}
      </div>

      <ApiCredentialField
        providerInfo={ordered.find((p) => p.name === "openai_api")}
        onSaved={async () => {
          await refresh();
          window.dispatchEvent(new CustomEvent("flowboard:llm-config-changed"));
        }}
      />

      <div className="selection-panel__actions">
        <button
          type="button"
          className="selection-panel__apply-btn"
          onClick={handleApply}
          disabled={!dirty || applying}
          title={
            dirty
              ? "保存以上提供商、模型与推理强度配置"
              : "当前没有未保存的更改"
          }
        >
          {applying ? "正在保存…" : dirty ? "保存配置" : "已保存"}
        </button>
      </div>

      {toast && (
        <div className="ai-providers-section__toast" role="alert">
          {toast}
        </div>
      )}

      <ProviderSetupModal
        provider={helpFor ?? "claude"}
        open={helpFor !== null}
        onClose={() => setHelpFor(null)}
      />
    </div>
  );
}

function resolvePreviewEndpoint(rawUrl: string, defaultBaseUrl: string): string | null {
  const cleaned = rawUrl.trim().replace(/\/+$/, "");
  if (!cleaned) return `${defaultBaseUrl}/chat/completions`;
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (cleaned.endsWith("/chat/completions")) return cleaned;
    if (parsed.pathname === "" || parsed.pathname === "/") {
      return `${cleaned}/v1/chat/completions`;
    }
    return `${cleaned}/chat/completions`;
  } catch {
    return null;
  }
}

function ApiCredentialField({
  providerInfo,
  onSaved,
}: {
  providerInfo: LLMProviderInfo | undefined;
  onSaved(): Promise<void>;
}) {
  const savedBaseUrl = providerInfo?.baseUrl ?? "";
  const defaultBaseUrl = providerInfo?.defaultBaseUrl ?? "https://api.openai.com/v1";
  const configured = providerInfo?.configured ?? false;

  const [baseUrlDraft, setBaseUrlDraft] = useState(savedBaseUrl);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const lastSavedUrlRef = useRef(savedBaseUrl);

  useEffect(() => {
    if (savedBaseUrl !== lastSavedUrlRef.current) {
      setBaseUrlDraft((prev) => (prev === lastSavedUrlRef.current ? savedBaseUrl : prev));
      lastSavedUrlRef.current = savedBaseUrl;
    }
  }, [savedBaseUrl]);

  const trimmedUrl = baseUrlDraft.trim().replace(/\/+$/, "");
  const trimmedKey = apiKeyDraft.trim();
  const baseUrlDirty = trimmedUrl !== savedBaseUrl;
  const canSave = !saving && (trimmedKey.length > 0 || baseUrlDirty);
  const previewEndpoint = resolvePreviewEndpoint(baseUrlDraft, defaultBaseUrl);

  async function handleSave() {
    if (!canSave) return;
    if (baseUrlDirty && trimmedUrl && !previewEndpoint) {
      setFeedback({
        tone: "err",
        text: "Base URL 必须以 http:// 或 https:// 开头并包含有效主机名。",
      });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const payload: { apiKey?: string | null; baseUrl?: string | null } = {};
      if (baseUrlDirty) payload.baseUrl = trimmedUrl || null;
      if (trimmedKey) payload.apiKey = trimmedKey;
      await setLlmProviderCredentials("openai_api", payload);
      lastSavedUrlRef.current = baseUrlDirty ? trimmedUrl : savedBaseUrl;
      setBaseUrlDraft(lastSavedUrlRef.current);
      setApiKeyDraft("");
      await onSaved();
      setFeedback({
        tone: "ok",
        text:
          baseUrlDirty && trimmedKey
            ? "自定义接口地址与 API 密钥均已保存。"
            : baseUrlDirty
              ? trimmedUrl
                ? "自定义 Base URL 已保存，后续接口请求与模型拉取将使用该地址。"
                : "已恢复默认官方接口地址。"
              : "API 密钥已保存，可直接用于画布对话与识图/提示词推理。",
      });
    } catch (err) {
      setFeedback({
        tone: "err",
        text: err instanceof Error ? err.message : "保存失败，请检查本地服务后重试。",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleResetBaseUrl() {
    if (saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      await setLlmProviderCredentials("openai_api", { baseUrl: null });
      lastSavedUrlRef.current = "";
      setBaseUrlDraft("");
      await onSaved();
      setFeedback({ tone: "ok", text: "已恢复默认官方接口地址。" });
    } catch (err) {
      setFeedback({
        tone: "err",
        text: err instanceof Error ? err.message : "恢复默认地址失败。",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleClearKey() {
    if (saving || !configured) return;
    setSaving(true);
    setFeedback(null);
    try {
      await setLlmProviderCredentials("openai_api", { apiKey: null });
      setApiKeyDraft("");
      await onSaved();
      setFeedback({ tone: "ok", text: "已清除本机保存的 API 密钥。" });
    } catch (err) {
      setFeedback({
        tone: "err",
        text: err instanceof Error ? err.message : "清除密钥失败。",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="feature-config-row api-endpoint-card"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <div className="feature-config-row__head">
        <span className="feature-config-row__title">
          OpenAI 兼容接口设置（自定义 Base URL 与 API 密钥）
        </span>
        <span className="feature-config-row__blurb">
          支持任意兼容 OpenAI 协议的中转站、私有代理网关或本地服务（如 Ollama / vLLM）；仅修改 Base URL 时不会清空已保存密钥，密钥仅存在本机且不回显。
        </span>
      </div>

      <div className="api-endpoint-card__grid">
        <div className="feature-config-row__field">
          <label className="feature-config-row__label" htmlFor="openai-base-url">
            接口地址 (Base URL)
          </label>
          <input
            id="openai-base-url"
            className="feature-config-row__model-input"
            type="url"
            autoComplete="off"
            spellCheck={false}
            value={baseUrlDraft}
            placeholder={`${defaultBaseUrl}（可填自定义中转站或本地服务地址）`}
            onChange={(event) => setBaseUrlDraft(event.target.value)}
          />
          <span className="api-endpoint-card__url-preview">
            {previewEndpoint
              ? `实际请求端点：${previewEndpoint}${trimmedUrl ? "" : "（官方默认）"}`
              : "请输入有效的 http:// 或 https:// 地址"}
          </span>
        </div>

        <div className="feature-config-row__field">
          <label className="feature-config-row__label" htmlFor="openai-service-key">
            API 密钥 (API Key)
          </label>
          <input
            id="openai-service-key"
            className="feature-config-row__model-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKeyDraft}
            placeholder={
              configured
                ? "密钥已保存（留空保持不变，输入新值可替换）"
                : "输入 sk-... API 密钥"
            }
            onChange={(event) => setApiKeyDraft(event.target.value)}
          />
          <span className="api-endpoint-card__url-preview">
            {configured ? "状态：已配置密钥（保存时未填新密钥将自动保留原密钥）" : "状态：尚未配置密钥"}
          </span>
        </div>
      </div>

      <div className="api-endpoint-card__actions">
        {savedBaseUrl && (
          <button
            type="button"
            className="feature-test-row__btn"
            disabled={saving}
            onClick={() => void handleResetBaseUrl()}
          >
            恢复默认地址
          </button>
        )}
        {configured && (
          <button
            type="button"
            className="feature-test-row__btn api-endpoint-card__clear"
            disabled={saving}
            onClick={() => void handleClearKey()}
          >
            清除密钥
          </button>
        )}
        <button
          className="feature-test-row__btn api-endpoint-card__save"
          type="submit"
          disabled={!canSave}
        >
          {saving ? "正在保存…" : "保存接口配置"}
        </button>
      </div>

      {feedback && (
        <p
          role="status"
          className={feedback.tone === "err" ? "feature-test-row__error" : "feature-test-row__latency"}
        >
          {feedback.tone === "err" ? `✗ ${feedback.text}` : `✓ ${feedback.text}`}
        </p>
      )}
    </form>
  );
}
