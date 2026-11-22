import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");
const ELECTRON_BIN = path.join(
  DESKTOP_DIR,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

const MOCK_PROJECT_ID = "1dfd992a-4149-4f97-9d68-a1ede77d3fc3";
const MOCK_AT_TOKEN = "wiz_at_token_998877";
const MOCK_UPLOADED_MEDIA_ID = "99a8b7c6-1111-4222-8333-445566778899";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

async function waitFor(fn, { timeoutMs = 25000, intervalMs = 200, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

/**
 * Starts a local HTTP server that accurately models Google Flow (flow.google.com):
 * 1. Unauthenticated GET / -> serves login button without WIZ_global_data.SNlM0e
 * 2. POST /__do_login -> sets HttpOnly SID cookie and redirects to /project/<uuid>
 * 3. Authenticated GET /project/<uuid> -> serves WIZ_global_data + grecaptcha.enterprise
 *    PLUS an active anti-extension hijack script attempting to overwrite
 *    grecaptcha.enterprise.execute with 'extension_hijack_detected'!
 * 4. POST /_/AiSandboxAngularFrontend/data/batchexecute -> validates Cookie, at token,
 *    source-path, and genuine minted reCAPTCHA token, returning valid wrb.fr envelopes.
 */
async function startMockFlowServer() {
  const recordedRpcs = [];
  let captchaCounter = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const cookieHeader = req.headers.cookie || "";
    const isSignedIn = cookieHeader.includes("SID=mock_google_sid_live");

    if (req.method === "GET" && url.pathname === "/__do_login") {
      res.writeHead(302, {
        "Set-Cookie": "SID=mock_google_sid_live; Path=/; Max-Age=86400; HttpOnly",
        Location: `/project/${MOCK_PROJECT_ID}`,
      });
      res.end();
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/_/AiSandboxAngularFrontend/data/batchexecute"
    ) {
      let rawBody = "";
      for await (const chunk of req) rawBody += chunk;
      const form = new URLSearchParams(rawBody);
      const freq = form.get("f.req") || "";
      const at = form.get("at") || "";
      const rpcids = url.searchParams.get("rpcids") || "";
      const sourcePath = url.searchParams.get("source-path") || "";

      recordedRpcs.push({
        rpcids,
        sourcePath,
        at,
        freq,
        cookieHeader,
        sameDomain: req.headers["x-same-domain"],
      });

      if (!isSignedIn || at !== MOCK_AT_TOKEN) {
        res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("UNAUTHENTICATED");
        return;
      }

      if (freq.includes("extension_hijack_detected")) {
        const errEnv = JSON.stringify([
          ["wrb.fr", rpcids, null, null, null, ["PUBLIC_ERROR_UNUSUAL_ACTIVITY"]],
        ]);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`)]}'\n\n${errEnv}\n`);
        return;
      }

      if (rpcids === "maseQ") {
        // Upload image RPC response: [[mediaId, projectId, operationId, "CAE"]]
        const innerPayload = JSON.stringify([
          [MOCK_UPLOADED_MEDIA_ID, MOCK_PROJECT_ID, "op_upload_1", "CAE"],
        ]);
        const envelope = JSON.stringify([["wrb.fr", "maseQ", innerPayload, null, null, null, "generic"]]);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`)]}'\n\n${envelope}\n`);
        return;
      }

      // Generic / ogiZ0b image generation RPC response
      const innerPayload = JSON.stringify({ ok: true, rpc: rpcids });
      const envelope = JSON.stringify([["wrb.fr", rpcids, innerPayload, null, null, null, "generic"]]);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`)]}'\n\n${envelope}\n`);
      return;
    }

    if (!isSignedIn) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Sign in - Google Flow</title></head>
<body>
  <h1>Sign in to Flow</h1>
  <a id="btn-mock-login" href="/__do_login">Sign in with Google</a>
</body>
</html>`);
      return;
    }

    // Authenticated Flow project page (with simulated anti-extension grecaptcha hijack!)
    captchaCounter += 1;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Flow Project</title>
  <script>
    window.WIZ_global_data = {
      SNlM0e: ${JSON.stringify(MOCK_AT_TOKEN)},
      FdrFJe: "88442211",
      cfb2h: "boq_aisandbox_202611"
    };
    let _mintSeq = 0;
    window.grecaptcha = {
      enterprise: {
        execute: async function (_siteKey, opts) {
          _mintSeq += 1;
          return "rc_enterprise_" + (opts && opts.action ? opts.action : "NONE") + "_" + _mintSeq;
        }
      }
    };
    // Simulate Google Flow's Sep 2026 anti-extension hijack wrapper!
    // flow-preload.ts MUST trap and block this redefine at document_start.
    try {
      Object.defineProperty(window.grecaptcha.enterprise, "execute", {
        configurable: true,
        value: async function () {
          return "extension_hijack_detected";
        }
      });
    } catch (_e) {}
  </script>
</head>
<body>
  <div id="flow-workspace">Signed in Flow Workspace (${url.pathname})</div>
</body>
</html>`);
    void captchaCounter;
  });

  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    recordedRpcs,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function spawnElectronInstance({
  storageDir,
  agentHttpPort,
  agentWsPort,
  e2ePort,
  flowOrigin,
  extraEnv = {},
}) {
  const logs = [];
  const child = spawn(ELECTRON_BIN, [DESKTOP_DIR], {
    cwd: DESKTOP_DIR,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FLOWBOARD_STORAGE: storageDir,
      FLOWBOARD_HTTP_PORT: String(agentHttpPort),
      FLOWBOARD_EXT_WS_PORT: String(agentWsPort),
      FLOWBOARD_E2E_PORT: String(e2ePort),
      FLOWBOARD_FLOW_BASE_URL: flowOrigin,
      ...extraEnv,
    },
  });

  child.stdout.on("data", (d) => logs.push(d.toString("utf8")));
  child.stderr.on("data", (d) => logs.push(d.toString("utf8")));

  const controlBase = `http://127.0.0.1:${e2ePort}`;
  await waitFor(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`Electron exited prematurely (${child.exitCode}):\n${logs.join("")}`);
      }
      const res = await fetch(`${controlBase}/status`);
      if (!res.ok) return false;
      const data = await res.json();
      return data.windowReady ? data : false;
    },
    { timeoutMs: 30000, label: "Electron E2E control server ready" },
  );

  return {
    child,
    logs,
    async getStatus() {
      const r = await fetch(`${controlBase}/status`);
      return r.json();
    },
    async evalCanvas(script) {
      const r = await fetch(`${controlBase}/eval-canvas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "evalCanvas failed");
      return data.result;
    },
    async evalFlow(script) {
      const r = await fetch(`${controlBase}/eval-flow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "evalFlow failed");
      return data.result;
    },
    async quit() {
      try {
        await fetch(`${controlBase}/quit`, { method: "POST" });
      } catch {
        // ignore
      }
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        sleep(5000).then(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }),
      ]);
    },
  };
}

test("Electron single-window studio runs Flow browser invisibly in inner layer end-to-end", async () => {
  assert.ok(fs.existsSync(ELECTRON_BIN), `Missing Electron binary at ${ELECTRON_BIN}`);
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, "frontend", "dist", "index.html")),
    "frontend/dist/index.html must be built before running E2E",
  );

  const tempStorage = fs.mkdtempSync(path.join(os.tmpdir(), "flowboard-electron-e2e-"));
  const mockPickPng = path.join(tempStorage, "mock-pick-upload.png");
  fs.writeFileSync(
    mockPickPng,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const mockFlow = await startMockFlowServer();
  const agentHttpPort = await getFreePort();
  const agentWsPort = await getFreePort();
  const e2ePort1 = await getFreePort();

  let app1 = null;
  let app2 = null;

  try {
    // ── 1. Launch single-window Electron Desktop App ──────────────────────────
    app1 = await spawnElectronInstance({
      storageDir: tempStorage,
      agentHttpPort,
      agentWsPort,
      e2ePort: e2ePort1,
      flowOrigin: mockFlow.origin,
      extraEnv: {
        FLOWBOARD_MOCK_PICK_FILES: JSON.stringify([mockPickPng]),
      },
    });

    const bootStatus = await app1.getStatus();
    assert.equal(bootStatus.agentOwned, true, "Electron should spawn and own FastAPI child process");
    assert.ok(bootStatus.agentPid > 0, "FastAPI PID should be recorded");

    // Verify Jimeng Canvas loaded with window.flowboardDesktop exposed
    const canvasInfo = await waitFor(async () => {
      const info = await app1.evalCanvas(`({
        hasBridge: Boolean(window.flowboardDesktop),
        hasCanvas: Boolean(document.querySelector('.react-flow__pane')),
        title: document.title
      })`);
      return info.hasBridge && info.hasCanvas ? info : false;
    }, { label: "Jimeng Canvas & flowboardDesktop bridge mounted" });
    assert.equal(canvasInfo.hasBridge, true);

    // ── 1b. Verify QuickCreatePopover dismisses on canvas click & Desktop onboarding guide renders ──
    const quickMenuDismissed = await app1.evalCanvas(`
      (async () => {
        const pane = document.querySelector('.react-flow__pane');
        if (!pane) throw new Error('Missing .react-flow__pane');
        const rect = pane.getBoundingClientRect();
        const cx = Math.round(rect.left + rect.width * 0.45);
        const cy = Math.round(rect.top + rect.height * 0.45);
        pane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        await new Promise((r) => setTimeout(r, 80));
        const opened = Boolean(document.querySelector('.drop-popover'));
        if (!opened) throw new Error('Expected .drop-popover to open after double-click');
        pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx + 20, clientY: cy + 20 }));
        pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx + 20, clientY: cy + 20 }));
        await new Promise((r) => setTimeout(r, 80));
        return document.querySelector('.drop-popover') === null;
      })()
    `);
    assert.equal(quickMenuDismissed, true, ".drop-popover must dismiss immediately when clicking .react-flow__pane");

    const guideText = await app1.evalCanvas(`
      (async () => {
        window.dispatchEvent(new CustomEvent('flowboard:open-flow-accounts'));
        await new Promise((r) => setTimeout(r, 120));
        const setupBtn = Array.from(document.querySelectorAll('.flow-accounts__setup button')).find((b) =>
          b.textContent && b.textContent.includes('账号导入与连接指引')
        );
        if (!setupBtn) throw new Error('Missing 账号导入与连接指引 button in embedded mode');
        setupBtn.click();
        await new Promise((r) => setTimeout(r, 80));
        const card = document.querySelector('.flow-accounts__guide-card');
        const text = card ? card.textContent : '';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return text;
      })()
    `);
    assert.ok(guideText.includes("Flowboard 连接助手"), `Expected Flowboard 连接助手 in guide: ${guideText}`);
    assert.ok(guideText.includes("配对"), `Expected 配对 step in guide: ${guideText}`);

    // ── 2. Click "添加账号" via UI / API & verify 0-click auto-pairing + login drawer ──
    const createdAccountId = await app1.evalCanvas(`
      (async () => {
        // Open account popover -> click 添加账号
        const res = await fetch('/api/flow-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: '工作室主账号', paygate_tier: 'PAYGATE_TIER_TWO' })
        });
        const created = await res.json();
        await fetch('/api/flow-accounts/' + created.created_account_id + '/activate?skip_launch=true', {
          method: 'POST'
        });
        await window.flowboardDesktop.syncAccountsNow();
        await window.flowboardDesktop.openDrawer({
          accountId: created.created_account_id,
          mode: 'auto-onboarding'
        });
        return created.created_account_id;
      })()
    `);

    // Wait for WS connection + login_required + EmbeddedFlowModal & built-in plugin card visible
    const prePairStatus = await waitFor(async () => {
      const st = await app1.getStatus();
      const s = st.inner?.state;
      if (s?.wsConnected && s?.paired === false && s?.authState === "login_required" && s?.drawerOpen) {
        return st;
      }
      return false;
    }, { label: "WS connected + unpaired + login_required + drawer open" });
    assert.equal(prePairStatus.inner.state.paired, false);

    // Verify built-in Flowboard 连接助手 plugin panel automatically appeared with pre-filled pairing code!
    const prefilledCode = await waitFor(async () => {
      return await app1.evalCanvas(`
        (() => {
          const plugin = document.querySelector('.jm-embedded-flow__plugin');
          const input = document.getElementById('embedded-pair-code');
          if (!plugin || !input || !input.value || input.value.trim().length < 6) return false;
          return input.value.trim();
        })()
      `);
    }, { label: "Built-in Flowboard 连接助手 plugin panel rendered with auto-prefilled pairing code" });
    assert.ok(prefilledCode.length >= 6);

    // User clicks "配对" button right inside the built-in plugin panel!
    await app1.evalCanvas(`document.getElementById('btn-embedded-pair').click()`);

    await waitFor(async () => {
      const st = await app1.getStatus();
      return st.inner?.state?.paired === true ? st : false;
    }, { label: "Explicit one-click pairing completed via built-in plugin panel" });

    // Modal remains open until user logs into Flow & opens project
    const stillOpenBeforeLogin = await app1.getStatus();
    assert.equal(stillOpenBeforeLogin.inner.state.drawerOpen, true);

    // ── 3. User signs in once inside inner browser -> auto-captures project_id & auto-hides! ──
    await app1.evalFlow(`document.getElementById('btn-mock-login').click()`);

    const postLoginStatus = await waitFor(async () => {
      const st = await app1.getStatus();
      const s = st.inner?.state;
      if (
        s?.authState === "authenticated" &&
        s?.projectIdDetected === MOCK_PROJECT_ID &&
        s?.drawerOpen === false &&
        st.inner?.visible === false
      ) {
        return st;
      }
      return false;
    }, { label: "Auto-authenticated + project_id auto-bound + inner view hidden" });

    assert.equal(postLoginStatus.inner.visible, false, "Inner WebContentsView must be invisible after login");
    assert.equal(postLoginStatus.inner.bounds.x, -10000, "Inner WebContentsView parked offscreen");

    // Verify FastAPI /api/flow-accounts & /api/health confirm full routing readiness
    const accountsSnap = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${agentHttpPort}/api/flow-accounts`, {
        headers: { Host: `127.0.0.1:${agentHttpPort}` },
      });
      const json = await res.json();
      const active = json.accounts[0];
      if (active?.connected && active?.flow_tab_open && active?.project_id === MOCK_PROJECT_ID) {
        return json;
      }
      return false;
    }, { label: "FastAPI sees connected=true, flow_tab_open=true, and auto-bound project_id" });
    assert.equal(accountsSnap.embedded_browser, true);

    // ── 4. Execute REAL RPCs while inner browser is 100% invisible ────────────
    // 4a. Real /api/upload -> maseQ batchexecute RPC inside hidden WebContentsView
    const png1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const form = new FormData();
    form.append("project_id", MOCK_PROJECT_ID);
    form.append("flow_account_id", createdAccountId);
    form.append("file", new Blob([png1x1], { type: "image/png" }), "ref.png");
    const uploadRes = await fetch(`http://127.0.0.1:${agentHttpPort}/api/upload`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${agentHttpPort}`,
        Origin: `http://127.0.0.1:${agentHttpPort}`,
      },
      body: form,
    });
    if (uploadRes.status !== 200) {
      assert.fail(`Upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
    }
    const uploadJson = await uploadRes.json();
    assert.equal(uploadJson.media_id, MOCK_UPLOADED_MEDIA_ID);

    // 4a-ui. Click real UI "添加图片节点" -> "上传" button -> out-of-process pickImages IPC -> /api/upload!
    await app1.evalCanvas(`
      (() => {
        const addImgBtn = document.querySelector('button[aria-label="添加图片节点"]');
        if (!addImgBtn) throw new Error('Missing 添加图片节点 button');
        addImgBtn.click();
      })()
    `);

    const uploadBtnReady = await waitFor(async () => {
      return await app1.evalCanvas(`
        (() => {
          const btn = Array.from(document.querySelectorAll('.node-body--image button')).find((b) =>
            b.textContent && b.textContent.includes('上传')
          );
          if (!btn) return false;
          if (!btn.classList.contains('nodrag')) throw new Error('Expected nodrag class on node upload button');
          btn.click();
          return true;
        })()
      `);
    }, { label: "Empty image node rendered with nodrag upload button & clicked" });
    assert.equal(uploadBtnReady, true);

    const uiUploadedSrc = await waitFor(async () => {
      return await app1.evalCanvas(`
        (() => {
          const img = document.querySelector('.node-body--image .thumbnail-tile__img');
          if (!img) return false;
          const src = img.getAttribute('src') || '';
          return src.includes(${JSON.stringify(MOCK_UPLOADED_MEDIA_ID)}) ? src : false;
        })()
      `);
    }, { label: "UI click upload completed via out-of-process pickImages IPC without blocking window" });
    assert.ok(uiUploadedSrc.includes(MOCK_UPLOADED_MEDIA_ID));

    // 4b. Dispatch real gen_image request -> verifies grecaptcha anti-hijack guard + __CAPTCHA__ mint!
    const genReqRes = await fetch(`http://127.0.0.1:${agentHttpPort}/api/requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: `127.0.0.1:${agentHttpPort}`,
        Origin: `http://127.0.0.1:${agentHttpPort}`,
      },
      body: JSON.stringify({
        type: "gen_image",
        flow_account_id: createdAccountId,
        params: {
          prompt: "赛博朋克雨夜霓虹街景",
          project_id: MOCK_PROJECT_ID,
          count: 1,
        },
      }),
    });
    assert.equal(genReqRes.status, 200);

    const ogiCall = await waitFor(
      () => mockFlow.recordedRpcs.find((r) => r.rpcids === "ogiZ0b") || false,
      { label: "ogiZ0b batchexecute RPC received by Flow server from hidden inner browser" },
    );

    assert.equal(ogiCall.at, MOCK_AT_TOKEN);
    assert.equal(ogiCall.sourcePath, `/project/${MOCK_PROJECT_ID}`);
    assert.equal(ogiCall.sameDomain, "1");
    assert.ok(
      ogiCall.freq.includes("rc_enterprise_IMAGE_GENERATION_"),
      `Expected genuine minted reCAPTCHA token in freq, got: ${ogiCall.freq.slice(0, 300)}`,
    );
    assert.ok(
      !ogiCall.freq.includes("extension_hijack_detected"),
      "Anti-hijack guard in flow-preload.ts must block extension_hijack_detected",
    );

    // Verify inner browser stayed invisible the entire time!
    const midStatus = await app1.getStatus();
    assert.equal(midStatus.inner.visible, false);
    assert.equal(midStatus.inner.state.drawerOpen, false);

    // ── 5. Shut down App 1 & verify FastAPI child process terminates cleanly ──
    const firstAgentPid = midStatus.agentPid;
    await app1.quit();
    app1 = null;

    await waitFor(
      async () => {
        try {
          await fetch(`http://127.0.0.1:${agentHttpPort}/api/health`);
          return false;
        } catch {
          return true;
        }
      },
      { timeoutMs: 10000, label: `FastAPI child PID ${firstAgentPid} stopped on Electron quit` },
    );

    // ── 6. Relaunch App 2 on same storage -> 100% zero-touch silent recovery! ─
    const e2ePort2 = await getFreePort();
    app2 = await spawnElectronInstance({
      storageDir: tempStorage,
      agentHttpPort,
      agentWsPort,
      e2ePort: e2ePort2,
      flowOrigin: mockFlow.origin,
    });

    const relaunchStatus = await waitFor(async () => {
      const st = await app2.getStatus();
      const s = st.inner?.state;
      if (
        s?.authState === "authenticated" &&
        s?.paired === true &&
        s?.wsConnected === true &&
        s?.drawerOpen === false &&
        st.inner?.visible === false
      ) {
        return st;
      }
      return false;
    }, { label: "Second launch silent authenticated recovery without any user prompt" });

    assert.equal(relaunchStatus.inner.state.drawerOpen, false);
    assert.equal(relaunchStatus.inner.visible, false);

    // Confirm FastAPI immediately reports extension_connected: true on relaunch
    const healthAfterRestart = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${agentHttpPort}/api/health`, {
        headers: { Host: `127.0.0.1:${agentHttpPort}` },
      });
      const h = await r.json();
      return h.extension_connected === true ? h : false;
    }, { label: "extension_connected === true on cold restart" });
    assert.equal(healthAfterRestart.extension_connected, true);

    // ── 7. Trigger In-Browser Shutdown Button + Jimeng Aurora Shutdown Animation ─
    await waitFor(async () => {
      return await app2.evalCanvas(`Boolean(document.getElementById('btn-open-shutdown'))`);
    }, { label: "#btn-open-shutdown power button mounted in TopRightCapsuleBar" });

    await app2.evalCanvas(`document.getElementById('btn-open-shutdown').click()`);

    const dialogReady = await waitFor(async () => {
      return await app2.evalCanvas(`Boolean(document.querySelector('.jm-shutdown-dialog') && document.getElementById('btn-confirm-shutdown'))`);
    }, { label: "Shutdown confirmation dialog rendered" });
    assert.equal(dialogReady, true);

    await app2.evalCanvas(`document.getElementById('btn-confirm-shutdown').click()`);

    const curtainPhase = await waitFor(async () => {
      return await app2.evalCanvas(`
        (() => {
          const el = document.querySelector('.jm-shutdown-curtain');
          const orb = document.querySelector('.jm-shutdown-orb__ring');
          if (!el || !orb) return false;
          return el.getAttribute('data-phase') || 'active';
        })()
      `);
    }, { label: "Jimeng Aurora Shutdown Curtain animation active" });
    assert.ok(curtainPhase === "saving" || curtainPhase === "stopping" || curtainPhase === "completed");

    // Wait for Electron app2 to quit on its own via quitApp() IPC after animation completes
    await new Promise((resolve, reject) => {
      if (app2.child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("Electron app2 did not exit after UI shutdown")), 12000);
      app2.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    app2 = null;

    await waitFor(
      async () => {
        try {
          await fetch(`http://127.0.0.1:${agentHttpPort}/api/health`);
          return false;
        } catch {
          return true;
        }
      },
      { timeoutMs: 10000, label: "FastAPI child stopped after UI shutdown button click" },
    );
  } finally {
    if (app1) await app1.quit();
    if (app2) await app2.quit();
    await mockFlow.close();
    try {
      fs.rmSync(tempStorage, { recursive: true, force: true });
    } catch {
      // ignore locked temp file cleanup delay on Windows
    }
  }
});

test("managedChromeMode renders Official Chrome Security Wizard, pairs via Chrome extension WS, auto-binds project_id, and auto-minimizes on restart", async () => {
  const tempStorage = fs.mkdtempSync(path.join(os.tmpdir(), "flowboard-chrome-wizard-"));
  const agentHttpPort = await getFreePort();
  const agentWsPort = await getFreePort();
  const e2ePort1 = await getFreePort();
  const logFile = path.join(tempStorage, "chrome-launches.jsonl");
  const mockChromeJs = path.join(tempStorage, "mock-chrome.mjs");
  const mockChromeCmd = path.join(tempStorage, "mock-chrome.cmd");

  fs.writeFileSync(
    mockChromeJs,
    `
import fs from "node:fs";
import path from "node:path";
import WebSocket from ${JSON.stringify(pathToFileURL(path.join(DESKTOP_DIR, "node_modules", "ws", "wrapper.mjs")).href)};

const args = process.argv.slice(2);
const logFile = ${JSON.stringify(logFile)};
fs.appendFileSync(logFile, JSON.stringify({ args }) + "\\n", "utf8");

const userDataArg = args.find((a) => a.startsWith("--user-data-dir="));
const userDataDir = userDataArg ? userDataArg.slice("--user-data-dir=".length) : "";
const pairFile = userDataDir ? path.join(userDataDir, "mock-paired.json") : "";

if (pairFile && fs.existsSync(pairFile)) {
  const saved = JSON.parse(fs.readFileSync(pairFile, "utf8"));
  const ws = new WebSocket("ws://127.0.0.1:${agentWsPort}", {
    headers: { Origin: "chrome-extension://mockbridge" },
  });
  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "profile_hello",
      profile_id: saved.profile_id,
      profile_token: saved.profile_token,
    }));
    ws.send(JSON.stringify({
      type: "profile_presence",
      flow_tab_open: true,
      project_id: saved.project_id,
    }));
  });
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 5000);
}
`,
    "utf8",
  );

  fs.writeFileSync(
    mockChromeCmd,
    `@echo off\r\n"${process.execPath}" "${mockChromeJs}" %*\r\n`,
    "utf8",
  );

  let app1 = null;
  let app2 = null;
  let extWs = null;

  try {
    const sharedEnv = {
      FLOWBOARD_FORCE_MANAGED_CHROME: "1",
      FLOWBOARD_CHROME_EXE: mockChromeCmd,
    };

    app1 = await spawnElectronInstance({
      storageDir: tempStorage,
      agentHttpPort,
      agentWsPort,
      e2ePort: e2ePort1,
      flowOrigin: "https://flow.google.com",
      extraEnv: sharedEnv,
    });

    // Create & activate an unpaired account and open the Official Chrome Security Wizard
    const accountId = await app1.evalCanvas(`
      (async () => {
        const res = await fetch('/api/flow-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: '官方Chrome托管账号', paygate_tier: 'PAYGATE_TIER_TWO' })
        });
        const created = await res.json();
        await fetch('/api/flow-accounts/' + created.created_account_id + '/activate?skip_launch=true', {
          method: 'POST'
        });
        await window.flowboardDesktop.syncAccountsNow();
        await window.flowboardDesktop.openDrawer({
          accountId: created.created_account_id,
          mode: 'auto-onboarding'
        });
        return created.created_account_id;
      })()
    `);

    // Verify Chrome Wizard modal opens with auto-generated pairing code & NO inner WebContentsView
    const pairCode = await waitFor(async () => {
      return await app1.evalCanvas(`
        (() => {
          const wizard = document.querySelector('.jm-embedded-flow-modal--chrome-wizard');
          const codeEl = document.getElementById('wizard-pair-code');
          if (!wizard || !codeEl) return false;
          const text = (codeEl.textContent || '').trim();
          return /^[0-9A-F]{6,24}$/i.test(text) ? text : false;
        })()
      `);
    }, { label: "Official Chrome Security Wizard modal rendered with pairing code" });

    // Confirm Chrome was requested foreground (--new-window) without embedded signin rejection webview
    const launch1 = await waitFor(() => {
      if (!fs.existsSync(logFile)) return false;
      const lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
      return lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : false;
    }, { label: "Managed Chrome launched for new account onboarding" });
    assert.ok(launch1.args.includes("--new-window"));
    assert.equal(launch1.args.some((a) => a.includes(accountId)), true);

    const stPre = await app1.getStatus();
    assert.equal(stPre.inner.state.managedChromeMode, true);
    assert.equal(stPre.inner.hasView, false, "Must NOT mount blocked embedded WebContentsView in managedChromeMode");

    // Simulate Flowboard Bridge Chrome extension pairing over WS :agentWsPort & detecting project_id
    extWs = new WebSocket(`ws://127.0.0.1:${agentWsPort}`, {
      headers: { Origin: "chrome-extension://mockbridge" },
    });
    await new Promise((resolve, reject) => {
      extWs.once("open", resolve);
      extWs.once("error", reject);
    });

    const pairedPayload = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for profile_paired")), 5000);
      extWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        if (msg.type === "profile_paired") {
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.type === "profile_pair_error") {
          clearTimeout(timer);
          reject(new Error(msg.detail));
        }
      });
      extWs.send(JSON.stringify({ type: "profile_hello", profile_id: null }));
      extWs.send(JSON.stringify({ type: "profile_pair", code: pairCode }));
    });

    const profileDir = path.join(tempStorage, "flow-browser-profiles", accountId);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "mock-paired.json"),
      JSON.stringify({
        profile_id: pairedPayload.profile_id,
        profile_token: pairedPayload.profile_token,
        project_id: MOCK_PROJECT_ID,
      }),
      "utf8",
    );

    extWs.send(JSON.stringify({
      type: "profile_presence",
      flow_tab_open: true,
      project_id: MOCK_PROJECT_ID,
    }));

    // Verify project_id auto-bound, authState=authenticated, and wizard auto-closed!
    const afterPairState = await waitFor(async () => {
      const st = await app1.getStatus();
      const s = st.inner?.state;
      if (
        s?.authState === "authenticated" &&
        s?.paired === true &&
        s?.wsConnected === true &&
        s?.projectIdDetected === MOCK_PROJECT_ID &&
        s?.drawerOpen === false
      ) {
        return s;
      }
      return false;
    }, { label: "Wizard auto-closes & project_id auto-binds when Chrome connects" });
    assert.equal(afterPairState.projectIdDetected, MOCK_PROJECT_ID);

    extWs.close();
    extWs = null;
    await app1.quit();
    app1 = null;

    // Clear launch log & restart App 2: paired account must auto-launch Chrome MINIMIZED in background!
    fs.writeFileSync(logFile, "", "utf8");
    const e2ePort2 = await getFreePort();
    app2 = await spawnElectronInstance({
      storageDir: tempStorage,
      agentHttpPort,
      agentWsPort,
      e2ePort: e2ePort2,
      flowOrigin: "https://flow.google.com",
      extraEnv: sharedEnv,
    });

    const launch2 = await waitFor(() => {
      if (!fs.existsSync(logFile)) return false;
      const lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
      return lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : false;
    }, { label: "Paired account auto-launches managed Chrome minimized on restart" });
    assert.ok(launch2.args.includes("--start-minimized"), `Expected --start-minimized, got ${JSON.stringify(launch2.args)}`);
    assert.ok(
      launch2.args.includes(`https://flow.google.com/project/${MOCK_PROJECT_ID}`),
      `Expected target project URL in args: ${JSON.stringify(launch2.args)}`,
    );

    const coldReady = await waitFor(async () => {
      const st = await app2.getStatus();
      const s = st.inner?.state;
      return s?.authState === "authenticated" && s?.paired === true && s?.drawerOpen === false ? s : false;
    }, { label: "Desktop recovers authenticated state silently without wizard popup" });
    assert.equal(coldReady.drawerOpen, false);

    await app2.quit();
    app2 = null;
  } finally {
    try {
      extWs?.close();
    } catch {
      // ignore
    }
    if (app1) await app1.quit();
    if (app2) await app2.quit();
    try {
      fs.rmSync(tempStorage, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
