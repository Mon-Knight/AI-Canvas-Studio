import { useState } from "react";
import {
  OFFICIAL_SUBJECT_TEMPLATES,
  SUBJECT_TEMPLATE_CATEGORIES,
  useSubjectTemplatesStore,
  type CustomSubjectTemplate,
  type SubjectTemplateCategory,
} from "../../constants/character";
import { PROMPT_MAX_LENGTH, type AspectKey } from "./aspectHelpers";

interface SubjectTemplatesPanelProps {
  prompt: string;
  inline: boolean;
  disabled: boolean;
  onApplyTemplate: (tpl: {
    prompt: string;
    recommendedAspect?: AspectKey;
  }) => void;
  onAutoFillCreatedPrompt: (promptText: string) => void;
}

export function SubjectTemplatesPanel({
  prompt,
  inline,
  disabled,
  onApplyTemplate,
  onAutoFillCreatedPrompt,
}: SubjectTemplatesPanelProps) {
  const customSubjectTemplates = useSubjectTemplatesStore(
    (s) => s.customTemplates,
  );
  const addCustomTemplate = useSubjectTemplatesStore(
    (s) => s.addCustomTemplate,
  );
  const updateCustomTemplate = useSubjectTemplatesStore(
    (s) => s.updateCustomTemplate,
  );
  const removeCustomTemplate = useSubjectTemplatesStore(
    (s) => s.removeCustomTemplate,
  );

  const [subjectTab, setSubjectTab] = useState<"official" | "custom">(
    "official",
  );
  const [subjectCategory, setSubjectCategory] =
    useState<SubjectTemplateCategory>("all");
  const [templateFormOpen, setTemplateFormOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(
    null,
  );
  const [tplTitleDraft, setTplTitleDraft] = useState("");
  const [tplPromptDraft, setTplPromptDraft] = useState("");

  const visibleOfficialTemplates =
    subjectCategory === "all"
      ? OFFICIAL_SUBJECT_TEMPLATES
      : OFFICIAL_SUBJECT_TEMPLATES.filter(
          (t) => t.category === subjectCategory,
        );

  function handleOpenCreateTemplate() {
    setEditingTemplateId(null);
    setTplTitleDraft("");
    setTplPromptDraft(prompt.trim());
    setTemplateFormOpen(true);
  }

  function handleOpenEditTemplate(tpl: CustomSubjectTemplate) {
    setEditingTemplateId(tpl.id);
    setTplTitleDraft(tpl.title);
    setTplPromptDraft(tpl.prompt);
    setTemplateFormOpen(true);
  }

  function handleSaveTemplateDraft() {
    const cleanTitle = tplTitleDraft.trim();
    const cleanPrompt = tplPromptDraft.trim();
    if (!cleanTitle || !cleanPrompt) return;
    if (editingTemplateId) {
      updateCustomTemplate(editingTemplateId, cleanTitle, cleanPrompt);
    } else {
      const created = addCustomTemplate(cleanTitle, cleanPrompt);
      if (created && !prompt.trim()) {
        onAutoFillCreatedPrompt(created.prompt);
      }
    }
    setSubjectTab("custom");
    setTemplateFormOpen(false);
    setEditingTemplateId(null);
  }

  return (
    <div className="gen-dialog__field jm-subject-tpl">
      <div className="jm-subject-tpl__header">
        <div
          className="jm-subject-tpl__tabs"
          role="tablist"
          aria-label="主体模板来源"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subjectTab === "official"}
            className={`jm-subject-tpl__tab${subjectTab === "official" ? " jm-subject-tpl__tab--active" : ""}`}
            onClick={() => setSubjectTab("official")}
          >
            官方推荐模板
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subjectTab === "custom"}
            className={`jm-subject-tpl__tab${subjectTab === "custom" ? " jm-subject-tpl__tab--active" : ""}`}
            onClick={() => setSubjectTab("custom")}
          >
            自定义模板 ({customSubjectTemplates.length})
          </button>
        </div>
        <button
          type="button"
          className="jm-subject-tpl__add-btn"
          onClick={handleOpenCreateTemplate}
          disabled={disabled}
          title="将当前提示词保存为自定义主体模板，或新建专属设定模板"
        >
          + {prompt.trim() ? "存为模板" : "新建模板"}
        </button>
      </div>

      {templateFormOpen && (
        <div
          className="jm-subject-tpl__editor"
          role="region"
          aria-label="编辑自定义主体模板"
        >
          <input
            type="text"
            className="jm-subject-tpl__input"
            maxLength={40}
            value={tplTitleDraft}
            onChange={(e) => setTplTitleDraft(e.target.value)}
            placeholder="模板名称（如：赛博二次元女主立绘 / 品牌吉祥物设定）"
            aria-label="自定义模板名称"
          />
          <textarea
            className="jm-subject-tpl__textarea"
            rows={2}
            maxLength={PROMPT_MAX_LENGTH}
            value={tplPromptDraft}
            onChange={(e) => setTplPromptDraft(e.target.value)}
            placeholder="输入可复用的主体设定提示词（支持二次元、3D、写实、萌宠、道具等任意风格）…"
            aria-label="自定义模板提示词"
          />
          <div className="jm-subject-tpl__editor-actions">
            <button
              type="button"
              className="gen-dialog__revert-btn"
              onClick={() => {
                setTemplateFormOpen(false);
                setEditingTemplateId(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="jm-subject-tpl__save-btn"
              disabled={!tplTitleDraft.trim() || !tplPromptDraft.trim()}
              onClick={handleSaveTemplateDraft}
            >
              {editingTemplateId ? "保存修改" : "保存模板"}
            </button>
          </div>
        </div>
      )}

      {subjectTab === "official" ? (
        <>
          <div className="jm-subject-tpl__cats" aria-label="官方模板分类">
            {SUBJECT_TEMPLATE_CATEGORIES.map((cat) => (
              <button
                key={cat.key}
                type="button"
                className={`jm-subject-tpl__cat${subjectCategory === cat.key ? " jm-subject-tpl__cat--active" : ""}`}
                onClick={() => setSubjectCategory(cat.key)}
              >
                {cat.label}
              </button>
            ))}
          </div>
          <div
            className={`jm-subject-tpl__grid${inline ? " jm-subject-tpl__grid--inline" : ""}`}
          >
            {visibleOfficialTemplates.map((tpl) => {
              const isApplied =
                prompt.trim() === tpl.prompt.trim() ||
                prompt.startsWith(tpl.prompt);
              return (
                <button
                  key={tpl.id}
                  type="button"
                  className={`jm-subject-tpl__card${isApplied ? " jm-subject-tpl__card--active" : ""}`}
                  onClick={() => onApplyTemplate(tpl)}
                  disabled={disabled}
                  title={`${tpl.summary}\n\n点击插入模板提示词，插入后可自由增删角色细节`}
                >
                  <div className="jm-subject-tpl__card-top">
                    <span className="jm-subject-tpl__card-title">
                      {tpl.title}
                    </span>
                    <span className="jm-subject-tpl__badge">{tpl.badge}</span>
                  </div>
                  {!inline && (
                    <p className="jm-subject-tpl__card-desc">{tpl.summary}</p>
                  )}
                </button>
              );
            })}
          </div>
        </>
      ) : customSubjectTemplates.length === 0 ? (
        <div className="jm-subject-tpl__empty">
          暂无自定义模板。可在下方输入常用动漫/角色/IP设定词后点击右上角「+
          存为模板」，方便随时一键复用。
        </div>
      ) : (
        <div
          className={`jm-subject-tpl__grid${inline ? " jm-subject-tpl__grid--inline" : ""}`}
        >
          {customSubjectTemplates.map((tpl) => {
            const isApplied =
              prompt.trim() === tpl.prompt.trim() ||
              prompt.startsWith(tpl.prompt);
            return (
              <div
                key={tpl.id}
                className={`jm-subject-tpl__card jm-subject-tpl__card--custom${isApplied ? " jm-subject-tpl__card--active" : ""}`}
              >
                <button
                  type="button"
                  className="jm-subject-tpl__custom-pick"
                  onClick={() => onApplyTemplate(tpl)}
                  disabled={disabled}
                  title={tpl.prompt}
                >
                  <span className="jm-subject-tpl__card-title">
                    {tpl.title}
                  </span>
                  {!inline && (
                    <span className="jm-subject-tpl__card-desc">
                      {tpl.prompt.length > 54
                        ? `${tpl.prompt.slice(0, 54)}…`
                        : tpl.prompt}
                    </span>
                  )}
                </button>
                <div className="jm-subject-tpl__custom-actions">
                  <button
                    type="button"
                    className="jm-subject-tpl__icon-btn"
                    onClick={() => handleOpenEditTemplate(tpl)}
                    title="编辑此自定义模板"
                    aria-label={`编辑模板 ${tpl.title}`}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="jm-subject-tpl__icon-btn jm-subject-tpl__icon-btn--del"
                    onClick={() => removeCustomTemplate(tpl.id)}
                    title="删除此自定义模板"
                    aria-label={`删除模板 ${tpl.title}`}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
