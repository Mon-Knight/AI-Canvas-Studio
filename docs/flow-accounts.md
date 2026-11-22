# Flow 账号导入、官方 Chrome 伴侣引擎与积分配置指南

## 方式一：单窗口桌面端 + 官方 Chrome 托管静默引擎（推荐）

通过双击根目录的 **`启动画布.vbs`**（或执行 `start-desktop.cmd` / `start.cmd --desktop`）启动单窗口桌面客户端。应用会在后台无黑框自动拉起本地 FastAPI 服务，并采用 **官方 Google Chrome 独立配置目录托管浏览器引擎**（彻底解决 Google 安全策略对内嵌网页视图拦截 `accounts.google.com/v3/signin/rejected` 的问题）：

### 已有已配对账号（日常零感使用）
- 若您已在 Web 模式或历史会话中配对过账号（如 `Flow 账号 1`，会持久化保存在 `storage/flow-browser-profiles/<accountId>`），重新打开桌面端后：
  - 系统会自动以**最小化后台模式**静默启动对应配置目录的正版 Chrome；
  - `Flowboard Bridge` 扩展自动连接本地桥接，桌面右上角指示灯亮起青蓝色/绿色即可直接生图、生视频，**不弹出登录拦截页、不抢占桌面焦点**。

### 首次添加 / 导入新 Google Flow 账号（3 步安全向导）
1. 点击右上角头像菜单（`Flow 账号菜单`）→ 展开 **「Flow 账号与积分」** → 点击 **「添加账号」**（或 **「唤起 Chrome 并配对」**）。
2. 系统会在前台拉起该账号专属配置目录的 **正版 Google Chrome**，并在画布中央显示紧凑的 **「官方 Chrome 安全连接向导」**：
   - **第 1 步（登录与进项）：** 在官方 Chrome 中正常登录开通 **Pro** 或 **Ultra** 的 Google 账号（完整支持账号密码、两步验证及 Passkey 通行密钥），然后进入任意 Flow 项目或新建项目。
   - **第 2 步（加载扩展）：** 在同一 Chrome 窗口地址栏输入 `chrome://extensions` → 开启右上角「开发者模式」→ 点击「加载已解压的扩展程序」，选择向导中可一键复制的 `extension` 目录（每个独立账号目录仅首次需要）。
   - **第 3 步（填入配对码）：** 复制向导自动生成的一次性配对码，粘贴到该 Chrome 窗口右上角「Flowboard Bridge」扩展弹窗点击 **「配对」**。
3. 当扩展连上且识别到 `flow.google.com/project/<uuid>` 后，向导会自动绑定项目 ID 并收起，同时自动将该 Chrome 窗口最小化到任务栏后台静默运行。
4. **设置实际套餐等级（必选）：** 在「Flow 账号与积分」中点击该账号卡片的 **「编辑项目与积分」**，将「生成套餐」设置为账号实际的 **Pro** 或 **Ultra** 并保存（Veo 3.1 闲时免积分队列需设为 **Ultra**）。

### 安全退出联动
- 点击右上角电源按钮 **「⏻ 关闭本地服务」**（或菜单内「关闭本地服务」），待保存与停止动画完成后，桌面工作台、本地 Agent 子进程及通过 `storage/flow-browser-profiles/` 托管的所有 Chrome 伴侣进程会同步优雅退出，绝不误关您日常个人使用的 Chrome 窗口。

---

## 方式二：Web 浏览器模式（`start.cmd --web`）

若通过 `start.cmd --web` 启动并在浏览器访问 `http://localhost:5173`，同样使用独立 Chrome 配置目录与扩展桥接：

1. 点击右上角头像菜单 →「Flow 账号与积分」→ **「添加账号」**，系统启动独立 Chrome 配置并打开 `flow.google.com`。
2. 在 Chrome 中登录已开通 `Pro` 或 `Ultra` 的 Google 账号，通过 `chrome://extensions`（开发者模式）加载仓库内 `extension` 目录。
3. 回到画布点击 **「获取配对码」**，填入该 Chrome 窗口「Flowboard Bridge」扩展弹窗点击 **「配对」**；进入 Flow 项目后复制项目链接或等待扩展自动识别绑定，并设置 **Pro / Ultra** 套餐保存。

---

## 可选：关联 Google 邮箱标识（本地 OAuth 资料导入）

- 展开 **「账号导入与连接指引」** 底部的「导入 Google 账号资料」仅用于通过本地 Google OAuth 展示邮箱名称，**不能替代**上方 Chrome Flow 网页登录与请求签名。
- 如需配置该可选项：在 Google Cloud Console 创建「Web 应用」OAuth 客户端，将指引中显示的回调地址（默认 `http://localhost:8434/api/flow-accounts/google/callback`）加入已获授权的重定向 URI，并在项目根目录 `.env` 填写 `FLOWBOARD_GOOGLE_CLIENT_ID` 与 `FLOWBOARD_GOOGLE_CLIENT_SECRET` 后重启本地服务。
