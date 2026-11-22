# Workspace Guidelines & UI Style Template (`f:/ai/huabu`)

## 1. 后期 UI 风格唯一基准：即梦画布 (Jimeng Canvas) 风格模板

本项目前端（`frontend/`）已将 **即梦 AI 无限画布（https://jimeng.jianying.com/）** 设定为后期所有界面重构与功能开发的 **强制性 UI/UX 风格模板**。

在修改或新增任何前端页面、样式（`frontend/src/styles.css`）、画布交互（`frontend/src/canvas/`）或业务组件（`frontend/src/components/`）时，**必须先阅读并严格遵循**：
- 完整设计系统与组件规范：`docs/design/jimeng-ui-template.md`
- 视觉参考截图归档：
  - `docs/design/jimeng-ref/01-canvas-overview.png`（全屏无边框沉浸画布、五区悬浮毛玻璃胶囊、极光微点阵与「双击画布 创建节点」空状态）
  - `docs/design/jimeng-ref/02-left-dock-expanded.png`（左侧垂直悬浮工具坞 Icon Rail + Hover 浮层展开中文标签）
  - `docs/design/jimeng-ref/03-asset-library-modal.png`（居中大圆角资产库弹窗：资产/主体/画布一级胶囊 + 媒体二级分类 + 6列多选网格）

### 核心 UI 约束速查
1. **无界全屏画布 + 悬浮毛玻璃岛屿**：禁止新增占据固定网格宽度的常驻侧边栏或通栏顶栏/底栏；所有外围控件均采用悬浮胶囊/浮岛（`rgba(24, 24, 27, 0.82)` + `backdrop-filter: blur(18px)` + `1px solid rgba(255, 255, 255, 0.07)`）。
2. **中性纯黑灰色彩体系**：画布底色使用 `#09090b`（Obsidian 纯黑系），面板使用中性炭灰阶（`#141417` / `#1c1c20` / `#27272c`），告别旧版偏蓝紫背景与高饱和电光紫大色块；主确认按钮采用高对比纯白实心胶囊或克制的即梦极光青蓝点缀（`#38bdf8`）。
3. **渐进式披露与就地交互**：
   - 左侧工具坞默认 `44px` 宽纯图标，Hover 时以浮层展开文字标签（不挤压画布引起视口抖动）。
   - 支持画布空白处双击（`onPaneDoubleClick`）就地唤出节点创建菜单。
   - AI 助手默认收纳为右下角 `与 AI 对话` 胶囊按钮，资产管理采用居中多选模态框（`资产 / 主体 / 画布`）。
4. **全简体中文专业创作术语**：前端所有新增或重构的用户可见文案统一使用简体中文（文本、图片、视频、主体、导演工具箱/故事板、便签、资产库、与 AI 对话），逐步替换遗留英文开发术语与 `ChatDock.tsx` 中的越南语文案。

---

## 2. 项目工程与本地运行约定（Windows 环境）

- **前端 (`frontend/`)**：Vite + React 18 + `@xyflow/react` 12 + Zustand 5 + TypeScript (`strict`)，开发端口 `:5173`。修改前端代码后必须执行 `npx tsc -p . --noEmit` 与 `npx vite build` 验证零类型与构建错误。
- **后端 (`agent/`)**：FastAPI + SQLModel + SQLite，监听 `127.0.0.1:8434`，扩展 WebSocket 桥监听 `:8355`。Windows 下虚拟环境位于 `agent/.venv/Scripts/`（启动脚本见根目录 `start.cmd`）。
- **架构边界**：前端仅与本地 FastAPI Agent 通信，严禁绕过现有 store / API 契约破坏 Google Flow 扩展桥接（`mediaId`、多变体连线 `sourceVariantIdx`、`autoBrief` 与 `autoPrompt` 合成链路）。
