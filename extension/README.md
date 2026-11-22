# Flowboard Bridge (Chrome MV3)

Local extension that proxies Flowboard agent requests to authenticated labs.google sessions.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.

## 配对画布账号

1. 在画布的「Flow 账号与积分」中添加一个账号，然后打开对应的独立 Chrome 窗口。
2. 在该 Chrome 窗口按上面的步骤加载本扩展。如果此前已安装，请在 `chrome://extensions` 点击重新加载。
3. 在 Flow 网页手动登录所需的 Google 账号。在画布获取配对码，打开该窗口里的扩展弹窗，输入配对码并点击「配对」。
4. 返回画布确认扩展已连接且 Flow 网页已打开。每个账号都应使用各自的窗口和浏览器配置；画布切换账号会切换本地任务的转发目标，不会改变 Google 登录状态。

配对凭据只用于连接本地 Agent，保存在对应 Chrome 配置的扩展本地存储，不会同步。扩展上报 Flow 标签页开关状态，不将其当作 Google 登录状态。

## How it works

- The service worker connects to `ws://127.0.0.1:8355` automatically when the agent is running.
- On first sign-in at `labs.google/fx/tools/flow` the `Authorization: Bearer ya29.*` token is captured automatically from outgoing request headers.
- Responses to agent `api_request` commands are sent via HTTP POST to `http://127.0.0.1:8434/api/ext/callback` with an `X-Callback-Secret` header (secret supplied by the agent on connect). WS fallback is used if HTTP fails.
- A keepalive `ping` is sent every ~20 s while connected; the alarm retries disconnected sessions.
- When an `api_request` includes `captchaAction`, the extension solves a reCAPTCHA Enterprise challenge via the injected MAIN-world script (`injected.js`) running on the Flow tab, then patches the token into the request body before forwarding.
- `trpc_request` commands are proxied directly to `https://labs.google/` with the captured Bearer token and browser credentials.

## Content script + injected script

`content.js` runs at `document_start` on `labs.google/fx/tools/flow*` pages. It injects `injected.js` into the MAIN world so it can reach `window.grecaptcha.enterprise`. The two scripts communicate via `CustomEvent` (`GET_CAPTCHA` / `CAPTCHA_RESULT`).

## Popup

Click the extension icon to pair this Chrome profile, check connection state, or open Flow. The unpaired popup also displays legacy session controls.

## Out of scope (this version)

- Side panel
- Agent-side TRPC media URL forwarding listener

See `docs/PLAN.md` for planned additions.
