import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useBoardStore } from "../store/board";
import { useReferencesStore } from "../store/references";
import { displayBoardName } from "../constants/nodeLabels";
import { STARTER_RECIPES } from "../constants/starterTemplates";
import { JimengPrismLogo } from "./JimengIcons";

/**
 * 即梦风格左上角悬浮品牌与项目切换胶囊：
 * 替代原 220px 常驻左侧栏 ProjectSidebar 与原通栏 Toolbar 左半区。
 */
export function TopLeftProjectBar() {
  const boards = useBoardStore((s) => s.boards);
  const activeId = useBoardStore((s) => s.boardId);
  const boardName = useBoardStore((s) => s.boardName);
  const switchBoard = useBoardStore((s) => s.switchBoard);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const deleteBoardById = useBoardStore((s) => s.deleteBoardById);
  const renameBoard = useBoardStore((s) => s.renameBoard);
  const exportCurrentBoardHuabu = useBoardStore((s) => s.exportCurrentBoardHuabu);
  const importHuabuFile = useBoardStore((s) => s.importHuabuFile);
  const applyStarterRecipe = useBoardStore((s) => s.applyStarterRecipe);

  const [menuOpen, setMenuOpen] = useState(false);
  const [editingCurrent, setEditingCurrent] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [newNameDraft, setNewNameDraft] = useState("");
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [armedDeleteId, setArmedDeleteId] = useState<number | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const huabuInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      setCreating(false);
      setNewNameDraft("");
      setRecipesOpen(false);
      setArmedDeleteId(null);
      return;
    }
    const onOutside = (e: Event) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  function startInlineRename() {
    setMenuOpen(false);
    setRenameDraft(displayBoardName(boardName));
    setEditingCurrent(true);
    requestAnimationFrame(() => renameInputRef.current?.select());
  }

  async function commitInlineRename() {
    setEditingCurrent(false);
    const next = renameDraft.trim();
    if (next && next !== boardName) {
      await renameBoard(next);
    }
  }

  function onRenameKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") renameInputRef.current?.blur();
    if (e.key === "Escape") setEditingCurrent(false);
  }

  function startCreate() {
    setCreating(true);
    setNewNameDraft("未命名项目");
    requestAnimationFrame(() => newInputRef.current?.select());
  }

  async function commitCreate() {
    if (creatingBusy) return;
    setCreatingBusy(true);
    try {
      const name = newNameDraft.trim() || "未命名项目";
      await createNewBoard(name);
      setCreating(false);
      setNewNameDraft("");
      setMenuOpen(false);
    } finally {
      setCreatingBusy(false);
    }
  }

  async function handleDeleteBoard(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (armedDeleteId !== id) {
      setArmedDeleteId(id);
      return;
    }
    setArmedDeleteId(null);
    await deleteBoardById(id);
  }

  return (
    <div ref={wrapRef} className="jm-topleft">
      <div className="jm-topleft__pill">
        <span className="jm-topleft__logo" title="画布工作台">
          <JimengPrismLogo size={22} />
        </span>

        {editingCurrent ? (
          <input
            ref={renameInputRef}
            className="jm-topleft__rename-input"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={() => void commitInlineRename()}
            onKeyDown={onRenameKeyDown}
            aria-label="项目名称"
          />
        ) : (
          <button
            type="button"
            className={`jm-topleft__trigger${menuOpen ? " jm-topleft__trigger--open" : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startInlineRename();
            }}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title="点击切换项目 · 双击重命名"
          >
            <span className="jm-topleft__name">{displayBoardName(boardName)}</span>
            <span className="jm-topleft__chevron" aria-hidden="true">⌄</span>
          </button>
        )}
      </div>

      {menuOpen && (
        <div className="jm-project-menu" role="menu" aria-label="画布项目管理">
          <div className="jm-project-menu__actions">
            <button
              type="button"
              className="jm-project-menu__action"
              onClick={startInlineRename}
            >
              <span>✎</span> 重命名当前项目
            </button>
            {!creating ? (
              <button
                type="button"
                className="jm-project-menu__action jm-project-menu__action--primary"
                onClick={startCreate}
              >
                <span>＋</span> 新建画布项目
              </button>
            ) : (
              <div className="jm-project-menu__create-row">
                <input
                  ref={newInputRef}
                  type="text"
                  className="jm-project-menu__create-input"
                  value={newNameDraft}
                  placeholder="输入新项目名称…"
                  disabled={creatingBusy}
                  onChange={(e) => setNewNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitCreate();
                    if (e.key === "Escape") setCreating(false);
                  }}
                />
                <button
                  type="button"
                  className="jm-project-menu__create-ok"
                  disabled={creatingBusy}
                  onClick={() => void commitCreate()}
                >
                  {creatingBusy ? "…" : "创建"}
                </button>
              </div>
            )}
            <button
              type="button"
              className="jm-project-menu__action"
              onClick={() => {
                setMenuOpen(false);
                useReferencesStore.getState().openPanel("boards");
              }}
            >
              <span>▦</span> 打开画布管理库
            </button>
            <button
              type="button"
              className="jm-project-menu__action"
              aria-expanded={recipesOpen}
              onClick={() => setRecipesOpen((v) => !v)}
            >
              <span>✦</span> {recipesOpen ? "收起新手指引示例" : "从新手指引示例新建"}
            </button>
            {recipesOpen && (
              <div className="jm-project-menu__recipes">
                {STARTER_RECIPES.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="jm-project-menu__recipe-item"
                    onClick={() => {
                      setMenuOpen(false);
                      void applyStarterRecipe(r.id, true);
                    }}
                  >
                    <span className="jm-project-menu__recipe-badge">{r.badge}</span>
                    <span>{r.title}</span>
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="jm-project-menu__action"
              onClick={() => huabuInputRef.current?.click()}
            >
              <span>⇩</span> 导入 .huabu 配方包…
            </button>
            <button
              type="button"
              className="jm-project-menu__action"
              onClick={() => {
                setMenuOpen(false);
                void exportCurrentBoardHuabu(true);
              }}
            >
              <span>⇧</span> 导出当前画布 (.huabu)
            </button>
            <input
              ref={huabuInputRef}
              type="file"
              accept=".huabu,application/zip"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setMenuOpen(false);
                void importHuabuFile(file);
              }}
            />
          </div>

          <div className="jm-project-menu__divider" />
          <div className="jm-project-menu__section-label">
            全部画布 ({boards.length})
          </div>

          <ul className="jm-project-menu__list">
            {boards.map((b) => {
              const isActive = b.id === activeId;
              const isArmed = armedDeleteId === b.id;
              return (
                <li key={b.id} className="jm-project-menu__item-wrap">
                  <div
                    className={`jm-project-menu__item${isActive ? " jm-project-menu__item--active" : ""}`}
                    onClick={() => {
                      void switchBoard(b.id);
                      setMenuOpen(false);
                    }}
                    role="menuitem"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void switchBoard(b.id);
                        setMenuOpen(false);
                      }
                    }}
                  >
                    <span className="jm-project-menu__check" aria-hidden="true">
                      {isActive ? "✓" : ""}
                    </span>
                    <span className="jm-project-menu__board-name">
                      {displayBoardName(b.name)}
                    </span>
                    <button
                      type="button"
                      className={`jm-project-menu__del${isArmed ? " jm-project-menu__del--armed" : ""}`}
                      onClick={(e) => void handleDeleteBoard(b.id, e)}
                      title={isArmed ? "再次点击确认删除" : "删除画布"}
                      aria-label="删除画布"
                    >
                      {isArmed ? "确认删除" : "×"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
