# AI Canvas Studio

> **即梦风格沉浸式 AI 无限画布创作工作台** — 支持角色锁脸、多格分镜故事板、文本直连与 AI 润色确认、视频首尾帧参考续接、多模型参数与积分实时预估，内置无感 Flow 浏览器引擎，提供 Windows 免环境安装包与绿色便携版。

---

## 核心特性

- **无界沉浸画布（Jimeng Obsidian UI）**：纯黑灰毛玻璃悬浮岛设计、微点阵背景、双击画布空白处就地建点，支持多画布管理与自由拖拽连线。
- **全能创作节点与上下文工作流**：
  - **文本 → 图片 / 视频**：支持直接继承上游文本提示词出图/出视频；点击「`✨ AI 润色`」后强制人工检查确认（支持「`↩ 还原原词`」），不会擅自扣积分提交。
  - **视频 → 视频 / 图片**：自动通过离屏 `<video> + <canvas>` 抽取上游视频尾帧（默认续接）或首帧参考，缓存在源节点上，实现连续分镜续拍与图生扩展。
  - **角色主体 & 分镜故事板**：内置正面肖像轴对称锁脸生成与 `2×2` / `2×3` / `2×4` 连拍分镜模板。
- **完整 Google Flow 模型目录与参数控制**：
  - **图片**：Nano Banana Pro / 2.1（可调思考深度）/ 2 Lite，支持 `1K / 2K / 4K` 重塑与 `1–4` 张输出。
  - **视频**：Veo 3.1（Lite / Fast / Quality / Ultra 零积分低优队列）与 Omni 1.1 / 1.2 Flash，统一开放 **3–15 秒**时长调节、清晰度选择（Omni 支持 `360p` 草稿与 `720p/1080p/4K` 超分；Veo 原生 `720p` 起并支持超分）及输出数量切换。
- **账户积分自动同步与实时预估**：自动拉取当前 Flow 账号余额与会员档位（Pro / Ultra），并在生成栏、弹窗与设置面板实时显示单次预计积分消耗。
- **单窗桌面端内置引擎**：无需手动安装 Chrome 扩展，桌面客户端内置 Chromium Flow 会话与进程外 Win32 文件选择器，点击上传图片不卡死。

---

## 普通用户快速上手（免 Python / Node 环境）

1. 前往本仓库 [GitHub Releases](https://github.com/Mon-Knight/AI-Canvas-Studio/releases) 下载最新 Windows 发行包：
   - **推荐安装版**：`AI-Canvas-Studio-v*-win64-setup.exe`（免管理员权限安装到当前用户目录，带桌面快捷方式，数据保存在 `%APPDATA%\ai-canvas-studio\workspace-storage`）
   - **绿色便携版**：`AI-Canvas-Studio-v*-win64-portable.zip`（解压后双击 `AI-Canvas-Studio.exe` 启动，全部画布与缓存数据保存在同目录 `data/` 下，可整包迁移）
2. 启动后点击右上角账号区域，在内层窗口登录你自己的 Google Flow 账号并打开任意 Flow 项目即可自动完成配对绑定。
3. （可选）点击「更多 → AI 服务与提示词设置」，填写自己的 OpenAI 兼容或 Gemini 接口及 BaseURL / Key，即可开启「`✨ AI 润色`」与图像视觉反推能力。

> **隐私与合规说明**：本软件采用 **本地运行 + 用户自带账号（BYOA）** 架构，所有登录凭证、提示词、画布 SQLite 数据库与媒体文件均仅保存在用户本机，项目仓库不包含任何个人凭据或代理服务。

---

## 开发者本地运行与打包

### 环境要求
- **Node.js**：`22+`
- **Python**：`3.10+`（建议在 `agent/.venv` 创建虚拟环境）

### 1. 初始化依赖
```powershell
# 后端 Python 环境
python -m venv agent\.venv
agent\.venv\Scripts\python.exe -m pip install -e "agent[dev]"

# 前端与桌面端
cd frontend && npm ci
cd ..\desktop && npm ci && npm run build
cd ..
```

### 2. 开发模式运行
- 前端静态构建：`cd frontend && npx vite build`
- Windows 一键静默启动桌面端：双击根目录 [启动画布.vbs](启动画布.vbs) 或运行 `start-desktop.cmd`
- 也可分开启动调试：`start.cmd --agent` 与 `start.cmd --frontend`

### 3. 本地打包 Windows 免环境发行版
安装 PyInstaller 后，运行一体化打包脚本即可生成 `release/AI-Canvas-Studio-v*-win64-portable.zip`（若本机装有 Inno Setup 6 将同步生成 `setup.exe`）：
```powershell
agent\.venv\Scripts\python.exe -m pip install pyinstaller
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\package-windows.ps1 -Version "1.4.0" -SkipNpmCi
```

### 4. GitHub Actions 自动发版
本仓库已配置两套工作流：
- `.github/workflows/ci.yml`：每次向 `main` 分支 `push` 或提交 PR 时，自动校验前端 `tsc` + `vite build` + `node --test`、桌面端 TypeScript 构建以及后端 `pytest`。
- `.github/workflows/release.yml`：打版本标签（如 `git tag v1.4.0 && git push origin v1.4.0`）或在 GitHub 网页 **Actions → Build & Release Windows Studio → Run workflow** 一键触发，云端自动编译 `Setup.exe` 与 `Portable.zip` 并发布至 Releases。

---

## GitHub 后续迭代路线图（Roadmap）

- [x] **阶段 1：工程脱敏 + 免环境独立打包 + GitHub CI/Release 自动构建**
- [ ] **阶段 2：`.huabu` 画布工作流包导出 / 导入** — 一键导出脱敏后的画布结构、参考素材与参数模板，他人拖入画布并自动将参考图重绑至自身 Flow 项目。
- [ ] **阶段 3：开箱精选模板库** — 内置角色三视图、剧情多格分镜、视频尾帧续拍等常用模板。
- [ ] **阶段 4：单文件只读作品预览页导出** — 生成可直接在浏览器查看创作链路与成片的静态 `.html`。
