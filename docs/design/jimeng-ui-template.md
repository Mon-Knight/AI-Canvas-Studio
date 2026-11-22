# 即梦画布 (Jimeng Canvas) UI 风格模板规范

> **基准参考**：字节跳动即梦 AI（https://jimeng.jianying.com/）无限画布 / 节点模式  
> **参考截图归档**：
> - `docs/design/jimeng-ref/01-canvas-overview.png`（全局无界画布、五区悬浮布局、中心空状态与极光点阵）
> - `docs/design/jimeng-ref/02-left-dock-expanded.png`（左侧垂直悬浮工具坞 Hover 渐进展开标签）
> - `docs/design/jimeng-ref/03-asset-library-modal.png`（资产库居中大模态框：资产/主体/画布三合一 + 多选网格）

本文档作为本项目（`f:/ai/huabu`）后期前端迭代与重构的**唯一 UI/UX 风格基准模板**。任何新增组件、弹窗、节点卡片与画布交互均须遵循本规范。

---

## 1. 核心设计哲学 (Design Principles)

1. **全画布无界沉浸 (Full-Bleed Zero-Bezel Canvas)**
   - 画布占据 `100vw × 100vh` 完整视口。**严禁**使用分割视口的固定通栏侧边栏（`border-right`）或常驻通栏顶栏（`border-bottom`）。
   - 所有全局导航、工具栏、状态区均采用**悬浮毛玻璃胶囊 / 浮岛 (`position: fixed/absolute` + `backdrop-filter`)**，让画布点阵在控件四周自然透出。
2. **中性深黑底色 + 内容绝对主角 (Obsidian Neutral Surface)**
   - 摒弃偏蓝紫的“程序员后台风”，采用纯正深邃的中性黑灰阶（Obsidian / Zinc `#09090b → #27272a`），确保 AI 生成的图片与视频色彩不被界面底色污染。
   - 强调色仅在品牌标识、空状态微光点阵、AI 对话入口等关键触点使用克制的**即梦极光青蓝渐变 (`#00d2ff → #38bdf8 → #3a7bd5`)**，常规主操作按钮优先采用**高对比纯白实心态 (`#ffffff` 底 + `#09090b` 字)** 或精致半透明高亮块。
3. **渐进式信息披露 (Progressive Disclosure)**
   - **平时极简，按需展开**：左侧工具坞默认仅显示 `44px` 宽图标轨，悬停时浮现文字标签层（不挤压画布宽度、不触发视口重排）；AI 助手平时收纳为右下角 `与 AI 对话` 胶囊按钮；资产与项目收纳于左上项目下拉与居中资产库模态框。
4. **就地上下文操作 (Contextual In-Place Workflow)**
   - 双击画布空白处或拖拽连线松开，直接在光标处唤出节点创建菜单。
   - 选中节点时，优先通过节点正下方的**悬浮上下文生成控制条 (Contextual Prompt Bar)** 完成提示词输入、`@` 素材引用、比例/模型选择与一键生成，减少全屏遮罩弹窗对画布连线关系的打断。
5. **全中文影视级创作语境 (Native Chinese Creative Terminology)**
   - 全面统一为符合国内视觉/影视创作者直觉的简约中文术语，彻底清理遗留的英文开发调试词（如 `Visual asset`、`● extension`）及越南语文案。

---

## 2. 设计令牌规范 (CSS Design Tokens)

在 `frontend/src/styles.css` 中统一采用以下 `:root` 变量体系：

```css
:root {
  color-scheme: dark;

  /* ── 基础背景与层级表面 (Obsidian & Zinc Scale) ── */
  --bg-canvas: #09090b;                          /* 画布极深纯黑底色 */
  --surface-glass: rgba(24, 24, 27, 0.82);       /* 悬浮胶囊/工具坞毛玻璃主表面 */
  --surface-glass-heavy: rgba(24, 24, 28, 0.92); /* 模态框/浮窗高不透明度表面 */
  --surface-1: #141417;                          /* 内凹输入框/搜索框底色 */
  --surface-2: #1c1c20;                          /* 节点卡片/列表默认底色 */
  --surface-3: #27272c;                          /* 卡片骨架屏/次级按钮/选中胶囊底色 */
  --surface-hover: rgba(255, 255, 255, 0.08);    /* 图标/列表项悬停态 */
  --surface-active: rgba(255, 255, 255, 0.14);   /* 工具坞激活圆角块底色 */

  /* ── 描边与分割线 (Hairline Borders) ── */
  --border-subtle: rgba(255, 255, 255, 0.07);    /* 浮岛、模态框、节点默认细描边 */
  --border-default: rgba(255, 255, 255, 0.12);   /* 输入框、次级控件描边 */
  --border-hover: rgba(255, 255, 255, 0.22);     /* 悬停态描边 */
  --border-focus: rgba(56, 189, 248, 0.65);      /* 聚焦/连线高亮描边 */

  /* ── 文本层级 (Typography Colors) ── */
  --text-primary: #f4f4f6;                       /* 主标题、激活文字 */
  --text-secondary: #a1a1aa;                     /* 常规图标、次级标签 */
  --text-muted: #71717a;                         /* 占位符、辅助说明、计数 */
  --text-inverse: #09090b;                       /* 纯白主按钮上的深色文字 */

  /* ── 品牌色与状态色 (Jimeng Aurora & Status) ── */
  --brand-cyan: #38bdf8;                         /* 即梦极光青蓝点缀色 */
  --brand-gradient: linear-gradient(135deg, #00e5ff 0%, #2979ff 55%, #7c4dff 100%);
  --cta-primary-bg: #f4f4f6;                     /* 高质感主确认按钮底色 */
  --cta-primary-hover: #ffffff;
  --status-success: #34d399;
  --status-warn: #fbbf24;
  --status-error: #f87171;

  /* ── 圆角阶梯 (Border Radius Ladder) ── */
  --radius-xs: 6px;                              /* 复选框、徽标小签 */
  --radius-sm: 10px;                             /* 资产网格卡片、内部按钮、搜索框 */
  --radius-md: 14px;                             /* 左侧悬浮工具坞、节点卡片、下拉菜单 */
  --radius-lg: 20px;                             /* 资产库居中大模态框、AI 对话抽屉 */
  --radius-pill: 9999px;                         /* 顶栏/底栏悬浮胶囊按钮 */

  /* ── 阴影与毛玻璃 (Elevation & Blur) ── */
  --blur-glass: blur(18px) saturate(140%);
  --shadow-island: 0 8px 28px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--border-subtle);
  --shadow-modal: 0 24px 64px rgba(0, 0, 0, 0.72), 0 0 0 1px var(--border-subtle);

  /* ── 字体与动效 ── */
  --font-sans: "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", Inter, system-ui, -apple-system, sans-serif;
  --ease-out-quart: cubic-bezier(0.22, 1, 0.36, 1);
}
```

---

## 3. 全局五区悬浮布局规范 (5-Zone Floating Shell)

整体界面取消 `.app { grid-template-columns: 220px 1fr }`，改为全屏 `.app-canvas-stage` 容器内叠加 5 个悬浮功能岛：

### 3.1 左上角：品牌与项目下拉胶囊 (`TopLeftProjectBar`)
- **位置**：`top: 12px; left: 12px; z-index: 30`
- **构成**：`[即梦风格彩色流光图标 24×24]` + `未命名项目 ⌄`（字号 `13px`，字重 `500`，悬停背景 `var(--surface-hover)`，圆角 `8px`）。
- **交互**：
  - 单击展开轻量毛玻璃下拉菜单：**新建画布**、**切换最近画布列表**、**重命名当前画布**、**删除画布**、**打开资产库（画布 Tab）**。
  - 彻底替代原占宽 `220px` 的常驻左侧 `ProjectSidebar`。

### 3.2 右上角：全局工具与账户胶囊组 (`TopRightCapsuleBar`)
- **位置**：`top: 12px; right: 12px; z-index: 30`，水平排列多个独立圆角胶囊（高度统一 `34px`，间距 `8px`，底色 `var(--surface-glass)` + `backdrop-filter: var(--blur-glass)`）：
  1. **检索与历史胶囊**：`🔍`（画布节点快速定位） + `🕒`（生成队列与活动记录，承接原 `ActivityBell`）。
  2. **导出/分享胶囊**：`↗ 分享`（或导出画布工作流 / 批量下载成片）。
  3. **更多菜单胶囊**：`···`（收纳 AI Provider 模型配置、Google Flow 项目绑定、快捷键说明等低频设置）。
  4. **连接状态与账户胶囊**：显示 Flow 扩展/Agent 在线绿点或算力标识（如 `✦ Ultra` / 连接状态） + 右侧 `24×24` 圆形头像，承接原左侧底部的 `AccountPanel` 与原左上角的 `StatusBar`，消除裸露的技术调试条。

### 3.3 左侧中部：垂直悬浮工具坞 (`LeftFloatingDock`)
- **位置**：`left: 12px; top: 50%; transform: translateY(-50%); z-index: 30`
- **默认收起态**：宽 `44px`，内边距 `6px 4px`，圆角 `14px` (`var(--radius-md)`)，毛玻璃深色浮岛，垂直排列 `36×36` 图标按钮（图标线性极简风，`18px`）。
- **悬停展开态（参考图 `02-left-dock-expanded.png`）**：
  - 鼠标移入工具坞时，右侧平滑浮现文字标签浮层（`padding-right: 16px`，带柔和暗色渐变遮罩背景，**绝不挤压底层画布布局**）。
  - 当前悬停/激活项图标呈现 `36×36` 圆角浅灰底块 (`var(--surface-active)`)，对应右侧中文名高亮为纯白 `#ffffff`。
  - 支持右上角青蓝新特性圆点徽标 (`#38bdf8`) 或微型 `Beta` 胶囊角标。
- **工具项标准编排（上区创作节点 + 分隔间距 + 下区资产动作）**：
  - **上区（创作与编排）**：
    1. `T` **文本**（创建提示词/脚本节点 `prompt`）
    2. `🖼️` **图片**（创建图片生成节点 `image`）
    3. `▶️` **视频**（创建视频生成节点 `video`）
    4. `ılı` **音频**（预留扩展槽位 / 配音音效）
    5. `🎞️` **时间线**（多镜头串联预览抽屉 / 预留槽位）
    6. `👤` **主体**（创建角色/产品锚点节点 `character` / `visual_asset`）
    7. `🎨` **导演工具箱**（对应 `Storyboard` 分镜宫格 / 镜头语法辅助）
    8. `🧊` **导演台**（`Beta` 角标，高级机位/构图预演扩展入口）
    9. `❖` **图层编辑**（选中图像的局部重绘 Refine / 编辑入口）
    10. `🗒️` **便签**（创建画布注释便签 `note`）
  - **下区（底部间距 `16px` 分隔后）**：
    11. `📁` **资产库**（打开居中统一资产库模态框）
    12. `↑` **上传**（触发本地文件选择，上传后直接在视口中心生成素材节点）

### 3.4 左下角：极简视口控制胶囊 (`BottomLeftViewportBar`)
- **位置**：`left: 12px; bottom: 12px; z-index: 30`
- **样式**：高度 `32px` 水平圆角胶囊，移除 ReactFlow 原生突兀的白色 `<Controls />` 方块与常驻巨型 `<MiniMap />`。
- **内容**：`▷`（全局序列预览） · `⊡`（按需呼出/隐藏深色迷你小地图 MiniMap & FitView 适应画布） · `连线显隐切换` · `100%`（实时显示当前缩放比例，点击可重置 100% 或选择 50% / 100% / 200%）。

### 3.5 右下角：AI 对话悬浮入口与侧滑抽屉 (`BottomRightAICopilot`)
- **位置**：`right: 16px; bottom: 16px; z-index: 30`
- **收起态（默认）**：圆润胶囊按钮 `height: 38px; padding: 0 16px; border-radius: 9999px`，左侧蓝青流光波形图标 + `与 AI 对话` 纯白文字，完全不遮挡画布底部创作区。
- **展开态**：点击后在右侧展开悬浮毛玻璃对话抽屉（`top: 58px; right: 12px; bottom: 12px; width: 360px; border-radius: 20px`），支持 `#节点` / `@主体` 引用、附图上传、流式执行步骤展示，所有提示文案统一为简体中文。

---

## 4. 核心画布与关键组件规范

### 4.1 画布点阵与空状态引导（参考图 `01-canvas-overview.png`）
- **极光微点阵背景**：
  - 底色 `#09090b`，点阵间距 `18px`，基础点色 `rgba(255, 255, 255, 0.07)`。
  - 画布中心叠加一层 `pointer-events: none` 的径向极光氛围层（青蓝 `rgba(14, 165, 233, 0.08)` 与暖金微光 `rgba(245, 158, 11, 0.04)`），使中心区域的点阵呈现出细腻的冷暖渐变光泽。
- **空画布中心引导**：
  - 当 `nodes.length === 0` 时，画布视口正中央展示非阻断式轻量引导：`双击画布  [彩色三角徽标]  创建节点`（字号 `14px`，颜色 `rgba(244, 244, 246, 0.65)`，`letter-spacing: 0.04em`）。一旦创建首个节点自动淡出。
- **双击空白处快捷创建 (`onPaneDoubleClick`)**：
  - 在画布空白处双击，或从节点连接柄拖出连线松开在空白处，统一在鼠标坐标处弹出**毛玻璃快捷创建菜单**（列表含：文本、图片、视频、主体、分镜故事板、便签、从资产库导入、上传本地文件）。

### 4.2 统一资产库居中模态框（参考图 `03-asset-library-modal.png`）
- **定位**：取代原右侧窄边栏 `ReferencesPanel`（及刺眼的紫金渐变脉冲星星贴片），改为居中大尺寸毛玻璃模态框（`width: min(860px, 92vw); height: min(620px, 84vh); border-radius: 20px`）。
- **双层头部导航**：
  - **第一行（一级域切换 + 关闭）**：胶囊切换组 `[资产]`（激活态底色 `#2c2c31`） · `主体` · `画布`，最右侧 `✕` 关闭图标。
  - **第二行（二级媒体类型 + 搜索筛选）**：左侧下划线标签 `图片`（底部 `2px` 纯白短横线指示器） · `视频` · `音频` · `文档`；右侧内凹胶囊搜索框 `🔍 搜索` + 日期排序按钮 + 筛选按钮。
- **内容网格与批量选择**：
  - 采用 `grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px` 等比正方形圆角卡片（`aspect-ratio: 1 / 1; border-radius: 10px; background: #27272c`）。
  - 卡片左上角常驻/悬停显示半透明圆角复选框（`18×18`），支持单选与多选；双击卡片可直接插入画布。
- **底部结算栏**：
  - 左侧显示 `已选择 N 个素材`（`12px`，`var(--text-secondary)`）。
  - 右侧 `确认` 按钮（`N === 0` 时为禁用深灰 `#2c2c31`；`N > 0` 时切换为高亮纯白主按钮，点击后将所选素材批量生成到画布当前视口并自动错位排布）。

### 4.3 节点卡片与上下文生成栏 (Node Card & Contextual Generator)
- **节点卡片 (`NodeCard`)**：
  - 去除左侧粗彩色 `StatusStrip` 竖条，改为：卡片上方外部悬浮轻量化节点头（小图标 + 中文节点名 + 状态胶囊），卡片本体为纯粹圆角媒体容器（`border-radius: 14px`，`1px solid var(--border-subtle)`，选中态细腻白青描边 `1.5px solid rgba(255,255,255,0.75)`；生成中采用柔和流光呼吸边框 + 内部微光骨架屏）。
  - 左右连接锚点（Handles）平时隐匿为极小暗点或悬停卡片时浮现圆形 `+` 锚点，连线采用平滑贝塞尔曲线（默认 `rgba(255,255,255,0.18)`，选中/激活流向高亮 `#38bdf8`）。
- **上下文生成控制栏 (`ContextualPromptBar`)**：
  - 单击选中可生成节点（图片 / 视频 / 主体 / 故事板）时，在节点正下方（跟随视口或底部悬浮）展开紧凑的即梦式输入舱：
    - 顶部：已连线的上游参考缩略图胶囊（支持点击切换多变体 `v1..v4`）。
    - 中部：无边框多行 Prompt 输入框（留空回车走 Auto-Prompt 自动合成）。
    - 底部工具行：模型选择胶囊（如 `GEM PIX 2` / `Veo 3.1` / `Omni`） · 比例胶囊（`16:9` / `9:16` / `1:1`） · 变体数/运镜胶囊（`静态` / `动态`、`1-4张`） · 右侧圆形/胶囊高亮发送生成按钮 `↑`。

---

## 5. 中文化术语对照表 (Terminology Map)

| 原项目概念 / 组件 | 即梦风格标准中文命名 | 说明 |
| :--- | :--- | :--- |
| `Untitled` / `Board` | `未命名项目` / `画布` | 左上角项目切换及资产库「画布」Tab |
| `Prompt` node | `文本` | 左侧工具坞第 1 项 |
| `Image` node | `图片` | 左侧工具坞第 2 项 |
| `Video` node | `视频` | 左侧工具坞第 3 项 |
| `Character` / `Visual asset` | `主体`（细分：角色 / 物品素材） | 统一收敛为「主体」锚点概念，资产库设独立「主体」Tab |
| `Storyboard` node | `故事板` / `导演工具箱` | 多镜头连续分镜宫格生成 |
| `Note` node | `便签` | 画布自由文本批注 |
| `Library` / `ReferencesPanel` | `资产库` | 居中双层 Tab 大模态框，含资产 / 主体 / 画布 |
| `ChatDock` (`Chat — hỏi AI...`) | `与 AI 对话` | 右下角胶囊触发器 + 右侧悬浮对话面板，彻底清除越南语 |
| `ActivityBell` | `历史记录` / `任务中心` | 收纳于右上角时钟图标胶囊 |
| `SponsorButton` | *移除（或收纳至关于菜单）* | 保持专业创作工具纯粹感，不在顶栏放置彩虹赞助按钮 |
