import { useId } from "react";
import type {
  LLMFeatureConfig,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderName,
} from "../../api/client";

export type FeatureTestState = "untested" | "testing" | "ok" | "fail";

export interface FeatureTest {
  state: FeatureTestState;
  latencyMs?: number;
  error?: string;
}

interface FeatureConfigRowProps {
  title: string;
  blurb: string;
  options: LLMProviderInfo[];
  allowFallback?: boolean;
  selected: LLMProviderInfo | null;
  value: LLMFeatureConfig;
  models: LLMModelInfo[];
  modelsRefreshing: boolean;
  test: FeatureTest;
  providerLabel(name: LLMProviderName): string;
  onProviderChange(name: LLMProviderName | null): void;
  onPatch(patch: Partial<LLMFeatureConfig>): void;
  onTest(): void;
  onRefreshModels(): void;
  onSetupHelp(): void;
}

export function FeatureConfigRow({
  title,
  blurb,
  options,
  allowFallback = false,
  selected,
  value,
  models,
  modelsRefreshing,
  test,
  providerLabel,
  onProviderChange,
  onPatch,
  onTest,
  onRefreshModels,
  onSetupHelp,
}: FeatureConfigRowProps) {
  const modelListId = useId();
  const hasProvider = selected !== null;
  const ready = hasProvider && selected.available && selected.configured;
  const efforts = selected?.supportsEffort ? selected.efforts : [];
  const offListProvider =
    hasProvider && !options.some((p) => p.name === selected.name)
      ? selected.name
      : null;
  const offListModel =
    value.model && !models.some((m) => m.id === value.model)
      ? value.model
      : null;

  return (
    <div className="feature-config-row">
      <div className="feature-config-row__head">
        <span className="feature-config-row__title">{title}</span>
        <span className="feature-config-row__blurb">{blurb}</span>
      </div>

      <div className="feature-config-row__controls">
        <label className="feature-config-row__field">
          <span className="feature-config-row__label">提供商</span>
          <select
            className="gen-dialog__select"
            value={value.provider ?? ""}
            onChange={(e) => onProviderChange((e.target.value || null) as LLMProviderName | null)}
          >
            {(allowFallback || !value.provider) && (
              <option value="" disabled={!allowFallback}>
                {allowFallback ? "跟随分镜规划" : "请选择…"}
              </option>
            )}
            {options.map((p) => (
              <option key={p.name} value={p.name}>
                {providerLabel(p.name)}
                {p.available && p.configured ? "" : " · 未就绪"}
              </option>
            ))}
            {offListProvider && (
              <option value={offListProvider}>
                {providerLabel(offListProvider)} · 不支持图像解析
              </option>
            )}
          </select>
        </label>

        <label className="feature-config-row__field">
          <span className="feature-config-row__label">模型</span>
          {models.length > 0 && selected?.name !== "openai_api" ? (
            <select
              className="gen-dialog__select"
              value={value.model ?? ""}
              disabled={!hasProvider}
              onChange={(e) => onPatch({ model: e.target.value || null })}
            >
              <option value="">
                {selected?.defaultModel
                  ? `默认 · ${selected.defaultModel}`
                  : "提供商默认模型"}
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {offListModel && (
                <option value={offListModel}>{offListModel} · 自定义</option>
              )}
            </select>
          ) : (
            <>
              <input
                type="text"
                className="feature-config-row__model-input"
                list={models.length > 0 ? modelListId : undefined}
                value={value.model ?? ""}
                disabled={!hasProvider}
                placeholder={selected?.defaultModel ?? "留空使用默认模型（可输入或点击 ⟳ 获取列表）"}
                onChange={(e) => onPatch({ model: e.target.value.trim() || null })}
              />
              {models.length > 0 && (
                <datalist id={modelListId}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label !== m.id ? m.label : undefined}
                    </option>
                  ))}
                </datalist>
              )}
            </>
          )}
        </label>

        <label className="feature-config-row__field feature-config-row__field--effort">
          <span className="feature-config-row__label">推理强度</span>
          {efforts.length > 0 ? (
            <select
              className="gen-dialog__select"
              value={value.effort ?? ""}
              onChange={(e) => onPatch({ effort: e.target.value || null })}
            >
              <option value="">默认</option>
              {efforts.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          ) : (
            <span
              className="feature-config-row__na"
              title={
                hasProvider
                  ? `${providerLabel(selected.name)} 不区分推理强度档位`
                  : "请先选择提供商"
              }
            >
              —
            </span>
          )}
        </label>

        <div className="feature-config-row__buttons">
          <button
            type="button"
            className="feature-test-row__btn"
            onClick={onRefreshModels}
            disabled={!hasProvider || modelsRefreshing}
            title="刷新提供商的模型列表"
            aria-label="刷新模型列表"
          >
            {modelsRefreshing ? "⟳…" : "⟳"}
          </button>
          <button
            type="button"
            className="feature-test-row__btn"
            onClick={onTest}
            disabled={!hasProvider || test.state === "testing"}
            title="发送一条真实模型请求测试连通性；API 服务商可能计费"
          >
            {test.state === "testing"
              ? "测试中…"
              : test.state === "untested"
                ? "测试"
                : "重测"}
          </button>
        </div>
      </div>

      <div className="feature-config-row__status">
        {test.state === "ok" && (
          <span className="feature-test-row__latency">
            ✓ 连通正常 · {test.latencyMs ?? "?"}ms
          </span>
        )}
        {test.state === "fail" && (
          <span className="feature-test-row__error">✗ {test.error}</span>
        )}
        {test.state === "testing" && (
          <span className="feature-test-row__hint">正在检查模型响应…</span>
        )}
        {test.state === "untested" && !hasProvider && (
          <span className="feature-test-row__hint">
            {allowFallback ? "跟随分镜规划；若也未指定，则使用 Muse。" : "尚未绑定提供商。"}
          </span>
        )}
        {test.state === "untested" && ready && (
          <span className="feature-test-row__hint">
            未测试（测试为可选项，可直接点击下方保存配置）。
          </span>
        )}
        {hasProvider && !ready && (
          <span className="feature-config-row__setup">
            <span className="feature-test-row__error">
              {selected.name === "openai_api" ? "请在本页「OpenAI API 密钥」中保存密钥。" : selected.lastError === "not_authenticated"
                ? `${providerLabel(selected.name)} CLI 已安装但尚未登录认证。`
                : `${providerLabel(selected.name)} CLI 尚未安装或不可用。`}
            </span>
            {selected.name !== "openai_api" && <button
              type="button"
              className="selection-panel__setup-btn"
              onClick={onSetupHelp}
            >
              配置指引 →
            </button>}
          </span>
        )}
      </div>
    </div>
  );
}
