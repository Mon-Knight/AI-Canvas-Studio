/**
 * Flowboard Bridge — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Captures Bearer token and proxies API calls through the browser context.
 */

const AGENT_WS_PORTS = [8355, 18355, 28355, 38355];
let activeWsPortIdx  = 0;
let wsProbeFailures  = 0;
const DEFAULT_CALLBACK_URL = 'http://127.0.0.1:8434/api/ext/callback';
const VALID_CALLBACK_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/api\/ext\/callback$/;
let callbackUrl      = DEFAULT_CALLBACK_URL;

let ws               = null;
let flowKey          = null;
let callbackSecret   = null; // Auth secret received from agent on WS connect
let state            = 'off'; // off | idle | running
let manualDisconnect = false;
let profileId = null;
let profileHelloSocket = null;
let callbackSocket = null;
let pendingPair = null;
let presenceVersion = 0;
let presenceTimer = null;
let lastFlowTabOpen = null;
let lastMusicTabOpen = null;
let lastProjectId = null;
let lastCreditsSyncAt = 0;
let creditsSyncInFlight = false;
const PROJECT_UUID_RE = /\/project\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9a-fA-F-])/;
let socketKeepalive = null;
let reconnectTimer = null;
let metrics = {
  tokenCapturedAt: null,
  requestCount:    0,
  successCount:    0,
  failedCount:     0,
  lastError:       null,
};

// Flow moved to flow.google.com in September 2026. In practice the only
// signed-in tab is flow.google.com/*; the labs.google patterns stay so an old
// pinned tab is still recognised rather than triggering a redundant spawn.
const flowUrls = [
  'https://flow.google.com/*',
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];

const managedFlowUrls = ['https://flow.google.com/*'];
const FLOWMUSIC_ORIGIN = 'https://www.flowmusic.app';
const flowMusicUrls = [
  'https://www.flowmusic.app/*',
  'https://flowmusic.app/*',
];

async function queryFlowTabs() {
  const tabs = await chrome.tabs.query({ url: profileId ? managedFlowUrls : flowUrls });
  return tabs.filter((tab) => !tab.incognito);
}

async function queryFlowMusicTabs() {
  const tabs = await chrome.tabs.query({ url: flowMusicUrls });
  return tabs.filter((tab) => !tab.incognito);
}

// ─── URL → Log Type Classifier ─────────────────────────────

function classifyUrl(url) {
  if (url.includes('batchGenerateImages'))     return 'GEN_IMG';
  if (url.includes('batchAsyncGenerateVideo')) return 'GEN_VID';
  if (url.includes('batchCheckAsync'))         return 'POLL';
  return 'API';
}

// ─── Request Log (last 50 entries) ─────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 50) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

// ─── Startup ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
});

async function init() {
  // Note: deliberately not restoring `userInfo` from storage. We used
  // to persist it here, but Google profile fields (name + email) are
  // PII and chrome.storage.local is plaintext + readable by other
  // extensions on the profile that hold the `storage` permission.
  // The agent replays user_info on every WS reconnect anyway via
  // fetchAndPushUserInfo(token), so persistence buys nothing.
  const data = await chrome.storage.local.get(['flowKey', 'metrics', 'callbackSecret']);
  if (data.flowKey)        flowKey        = data.flowKey;
  if (data.metrics)        Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  connectToAgent();
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
}

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Always update — even if same token string, refresh the timestamp
    const tokenChanged = flowKey !== token;
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });

    // Only emit on the WS when the token actually rotated. The listener
    // fires on EVERY outbound aisandbox-pa request — and the agent's
    // own poll loops generate dozens per minute. Re-sending the same
    // string each time pushed the agent into an effective infinite
    // /v1/credits refresh loop (one credits GET per poll). The agent
    // side has a defensive dedupe too, but quiet at the source first.
    if (tokenChanged) {
      console.log('[Flowboard] Bearer token captured');
      if (canSendLegacyIdentity()) {
        ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
      }
      // Resolve the user's identity (email/name/picture) once per token —
      // saves the popup + AccountPanel from showing "Connected via
      // extension" placeholders. The token already has the userinfo.email
      // + userinfo.profile scopes Flow needs anyway, so this is a free
      // call. Errors are non-fatal and silent.
      fetchAndPushUserInfo(token);
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);

let cachedUserInfo = null;

async function fetchAndPushUserInfo(token) {
  try {
    const resp = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      console.warn('[Flowboard] userinfo fetch returned', resp.status);
      return;
    }
    const info = await resp.json();
    // In-memory only — DO NOT persist to chrome.storage.local. PII
    // there is plaintext on disk and readable by other extensions
    // with the `storage` permission. Lifetime = service-worker
    // lifetime; rebuilt on next token rotation if the SW recycles.
    cachedUserInfo = info;
    console.log('[Flowboard] userinfo captured for', info?.email || '<no email>');
    if (canSendLegacyIdentity()) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: info }));
    }
  } catch (e) {
    console.warn('[Flowboard] userinfo fetch failed:', e?.message || e);
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  const targetWsUrl = `ws://127.0.0.1:${AGENT_WS_PORTS[activeWsPortIdx]}`;
  let openedOnThisAttempt = false;
  try {
    ws = new WebSocket(targetWsUrl);
  } catch (e) {
    console.error('[Flowboard] WS connect error:', e);
    activeWsPortIdx = (activeWsPortIdx + 1) % AGENT_WS_PORTS.length;
    wsProbeFailures++;
    scheduleReconnect(wsProbeFailures < AGENT_WS_PORTS.length ? 350 : 5000);
    return;
  }

  const socket = ws;
  socket.onopen = async () => {
    openedOnThisAttempt = true;
    wsProbeFailures = 0;
    console.log('[Flowboard] Connected to agent at', targetWsUrl);
    clearTimeout(reconnectTimer);
    chrome.alarms.clear('reconnect');

    const saved = await chrome.storage.local.get(['profileId', 'profileToken']).catch(() => ({}));
    if (socket !== ws || socket.readyState !== WebSocket.OPEN) return;
    profileId = typeof saved.profileId === 'string' && saved.profileId &&
      typeof saved.profileToken === 'string' && saved.profileToken ? saved.profileId : null;
    const profileToken = profileId ? saved.profileToken : null;
    socket.send(JSON.stringify({ type: 'profile_hello', profile_id: profileId, profile_token: profileToken }));
    profileHelloSocket = socket;
    lastFlowTabOpen = null;
    lastMusicTabOpen = null;
    lastProjectId = null;
    clearInterval(socketKeepalive);
    socketKeepalive = setInterval(keepAlive, 20000);
    setState('idle');

    sendExtensionReady(socket);
    if (callbackSocket === socket) replayLegacyIdentity();
    queuePresenceUpdate();
  };

  socket.onmessage = async ({ data }) => {
    if (socket !== ws) return;
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'profile_paired') {
        if (typeof msg.profile_id !== 'string' || typeof msg.profile_token !== 'string') {
          finishPair({ error: '本地服务返回了无效的配对信息。' });
          return;
        }
        try {
          await chrome.storage.local.set({ profileId: msg.profile_id, profileToken: msg.profile_token });
        } catch {
          finishPair({ error: '配对信息未能保存，请重新生成配对码。' });
          socket.close();
          return;
        }
        if (socket !== ws) return;
        profileId = msg.profile_id;
        lastFlowTabOpen = null;
        lastMusicTabOpen = null;
        lastProjectId = null;
        sendExtensionReady(socket);
        queuePresenceUpdate();
        finishPair({ ok: true });
        broadcastStatus();
      } else if (msg.type === 'profile_pair_error') {
        finishPair({ error: typeof msg.detail === 'string' ? msg.detail : '配对失败，请重新获取配对码。' });
      } else if (msg.type === 'callback_secret') {
        callbackSocket = socket;
        callbackSecret = msg.secret;
        if (typeof msg.callback_url === 'string' && VALID_CALLBACK_URL_RE.test(msg.callback_url)) {
          callbackUrl = msg.callback_url;
        }
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[Flowboard] Received callback secret');
        replayLegacyIdentity();
      } else if (msg.type === 'pong') {
        // keepalive response — no-op
      } else if (msg.type === 'logout') {
        // Agent's /api/auth/logout invoked — drop in-memory identity
        // so the next reconnect picks up fresh credentials. Don't
        // touch chrome.storage (we don't persist identity there
        // anyway, but be explicit). The WS stays open; agent will
        // re-greet when the user logs back in.
        console.log('[Flowboard] logout requested by agent');
        cachedUserInfo = null;
        flowKey = null;
        capturedFlowMusicSession = null;
      } else if (msg.type === 'please_resend_userinfo') {
        if (!canSendLegacyIdentity()) return;
        // Agent's /api/auth/scan asks us to re-fetch userinfo when
        // its own cache is empty (e.g. agent restarted, or user
        // clicked "Scan extension" before WS finished its first
        // round-trip). If we have a cached profile, replay it
        // immediately; otherwise refetch from Google's userinfo
        // endpoint with whatever Bearer token we currently hold.
        if (cachedUserInfo) {
          ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
        } else if (flowKey) {
          fetchAndPushUserInfo(flowKey);
        } else {
          console.log('[Flowboard] please_resend_userinfo: no token captured yet');
        }
      } else if (msg.method === 'batch_rpc') {
        await handleBatchRpc(msg);
      } else if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.method === 'flowmusic_open') {
        await handleFlowMusicOpen(msg);
      } else if (msg.method === 'flowmusic_get_token') {
        await handleFlowMusicGetToken(msg);
      } else if (msg.method === 'flowmusic_refresh_session') {
        await handleFlowMusicRefreshSession(msg);
      } else if (msg.method === 'flowmusic_fetch') {
        await handleFlowMusicFetch(msg);
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      }
    } catch (e) {
      console.error('[Flowboard] Message error:', e);
    }
  };

  socket.onclose = () => {
    if (socket !== ws) return;
    clearInterval(socketKeepalive);
    socketKeepalive = null;
    profileHelloSocket = null;
    callbackSocket = null;
    lastFlowTabOpen = null;
    lastMusicTabOpen = null;
    lastProjectId = null;
    finishPair({ error: '扩展与本地服务的连接已断开，请重试。' });
    setState('off');
    if (!manualDisconnect) {
      if (!openedOnThisAttempt) {
        activeWsPortIdx = (activeWsPortIdx + 1) % AGENT_WS_PORTS.length;
        wsProbeFailures++;
        scheduleReconnect(wsProbeFailures < AGENT_WS_PORTS.length ? 350 : 5000);
      } else {
        scheduleReconnect(5000);
      }
    }
  };

  socket.onerror = (e) => {
    if (socket !== ws) return;
    console.error('[Flowboard] WS error:', e);
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect(delayMs = 5000) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectToAgent, delayMs);
  chrome.alarms.create('reconnect', { delayInMinutes: 0.5 });
}

function keepAlive() {
  if (profileHelloSocket && profileHelloSocket === ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
    queuePresenceUpdate();
    void syncCreditsFromFlowTab(false);
  } else {
    connectToAgent();
  }
}

function sendExtensionReady(socket) {
  socket.send(JSON.stringify({
    type: 'extension_ready',
    flowKeyPresent: !profileId && !!flowKey,
    tokenAge: !profileId && flowKey && metrics.tokenCapturedAt
      ? Date.now() - metrics.tokenCapturedAt
      : null,
  }));
}

function canSendLegacyIdentity() {
  return !profileId && profileHelloSocket === ws && callbackSocket === ws &&
    ws?.readyState === WebSocket.OPEN;
}

function replayLegacyIdentity() {
  // Older agents (and the explicit legacy mode) greet with callback_secret.
  // Managed profiles do not replay cached third-party identity over this link.
  if (!canSendLegacyIdentity()) return;
  if (flowKey) ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
  if (cachedUserInfo) {
    ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
  } else if (flowKey) {
    fetchAndPushUserInfo(flowKey);
  }
}

function extractProjectIdFromTabs(tabs) {
  for (const tab of tabs) {
    const rawUrl = typeof tab?.url === 'string' ? tab.url : '';
    const match = rawUrl.match(PROJECT_UUID_RE);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function queuePresenceUpdate() {
  const version = ++presenceVersion;
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(async () => {
    const socket = profileHelloSocket;
    if (!socket || socket !== ws || socket.readyState !== WebSocket.OPEN) return;
    const [tabs, musicTabs] = await Promise.all([
      queryFlowTabs().catch(() => null),
      queryFlowMusicTabs().catch(() => []),
    ]);
    if (version !== presenceVersion || socket !== ws || socket.readyState !== WebSocket.OPEN || !tabs) return;
    const flowTabOpen = tabs.length > 0;
    const musicTabOpen = Array.isArray(musicTabs) && musicTabs.length > 0;
    const detectedProjectId = extractProjectIdFromTabs(tabs);
    if (
      flowTabOpen === lastFlowTabOpen &&
      musicTabOpen === lastMusicTabOpen &&
      detectedProjectId === lastProjectId
    ) {
      return;
    }
    socket.send(JSON.stringify({
      type: 'profile_presence',
      flow_tab_open: flowTabOpen,
      music_tab_open: musicTabOpen,
      project_id: detectedProjectId,
    }));
    lastFlowTabOpen = flowTabOpen;
    lastMusicTabOpen = musicTabOpen;
    lastProjectId = detectedProjectId;
    if (flowTabOpen) {
      void syncCreditsFromFlowTab(true);
    }
  }, 100);
}

async function syncCreditsFromFlowTab(force = false) {
  if (creditsSyncInFlight) return;
  if (!profileHelloSocket || profileHelloSocket !== ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!force && now - lastCreditsSyncAt < 45000) return;

  const tabs = await queryFlowTabs().catch(() => []);
  const tab = tabs.find((t) => !t.discarded) || tabs[0];
  if (!tab?.id) return;

  creditsSyncInFlight = true;
  lastCreditsSyncAt = now;
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        try {
          const wiz = globalThis.WIZ_global_data || {};
          const at = wiz.SNlM0e;
          if (at) {
            const url =
              `/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=nzlxg` +
              `&source-path=${encodeURIComponent(location.pathname || '/')}` +
              `&bl=${encodeURIComponent(wiz.cfb2h || '')}` +
              `&f.sid=${encodeURIComponent(wiz.FdrFJe || '')}` +
              `&hl=zh&_reqid=${Math.floor(Math.random() * 900000) + 100000}&rt=c`;
            const resp = await fetch(url, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'x-same-domain': '1',
              },
              body: new URLSearchParams({
                'f.req': JSON.stringify([[['nzlxg', '[]', null, 'generic']]]),
                at,
              }),
            });
            if (resp.ok) {
              const text = await resp.text();
              const body = text.startsWith(")]}'") ? text.slice(text.indexOf('\n') + 1) : text;
              for (const line of body.split('\n')) {
                const s = line.trim();
                if (!s.startsWith('[')) continue;
                try {
                  const chunk = JSON.parse(s);
                  for (const item of Array.isArray(chunk) ? chunk : []) {
                    if (Array.isArray(item) && item[0] === 'wrb.fr' && item[1] === 'nzlxg' && typeof item[2] === 'string') {
                      const arr = JSON.parse(item[2]);
                      if (Array.isArray(arr)) {
                        const coerce = (v) => {
                          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
                          if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
                          return null;
                        };
                        const total = coerce(arr[0]);
                        const tierCode = coerce(arr[1]);
                        const topUp = coerce(arr[4]);
                        const sub = coerce(arr[5]);
                        const credits = total !== null ? total : ((sub ?? 0) + (topUp ?? 0));
                        const paygate_tier =
                          tierCode === 1 ? 'PAYGATE_TIER_ONE' : (tierCode === 2 || tierCode === 8) ? 'PAYGATE_TIER_TWO' : null;
                        if (typeof credits === 'number' && Number.isFinite(credits) && credits >= 0) {
                          return { credits, paygate_tier };
                        }
                      }
                    }
                  }
                } catch {}
              }
            }
          }
          const el = document.querySelector('.credits-count, .credits-amount');
          if (el?.textContent) {
            const digits = el.textContent.replace(/[^\d]/g, '');
            if (digits) return { credits: Number(digits), paygate_tier: null };
          }
        } catch {}
        return null;
      },
    });
    const res = injected?.result;
    if (
      res &&
      typeof res.credits === 'number' &&
      Number.isFinite(res.credits) &&
      res.credits >= 0 &&
      ws?.readyState === WebSocket.OPEN &&
      profileHelloSocket === ws
    ) {
      ws.send(JSON.stringify({
        type: 'profile_credits',
        credits: Math.floor(res.credits),
        paygate_tier: res.paygate_tier || null,
      }));
    }
  } catch {
    // Non-fatal: tab may be navigating or still loading
  } finally {
    creditsSyncInFlight = false;
  }
}

chrome.tabs.onCreated.addListener(queuePresenceUpdate);
chrome.tabs.onRemoved.addListener(queuePresenceUpdate);
chrome.tabs.onReplaced.addListener(queuePresenceUpdate);
chrome.tabs.onUpdated.addListener((_id, changes) => {
  if (changes.url !== undefined || changes.status === 'complete') queuePresenceUpdate();
});

function finishPair(result) {
  if (!pendingPair) return;
  const { reply, timer } = pendingPair;
  pendingPair = null;
  clearTimeout(timer);
  reply(result);
}

// ─── Send to Agent ──────────────────────────────────────────

/**
 * Route a message to the agent.
 * Responses (msg.id present) go via HTTP callback — immune to WS drops.
 * Falls back to WS on HTTP failure. Non-response messages use WS directly.
 */
function sendToAgent(msg) {
  if (msg.id) {
    fetch(callbackUrl, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Callback-Secret': callbackSecret || '',
      },
      body: JSON.stringify(msg),
    }).then((resp) => {
      if (!resp.ok && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }).catch(() => {
      // HTTP failed — fall back to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, status, token_captured)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Reply to Flow Music RPCs directly over the active WebSocket.
 * Flow Music sockets are routed independently of `callback_secret`, so sending
 * directly over WS avoids HTTP 403 drops when no flow.google.com tab is open.
 */
function sendMusicReply(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
      return;
    } catch {
      // fall through to HTTP callback fallback
    }
  }
  sendToAgent(msg);
}

// ─── Page-context RPC runner (the current path) ─────────────
//
// Flow's rewritten frontend signs its calls with the session cookie plus a
// per-page `at` token, and every generate also carries a single-use reCAPTCHA.
// None of that can be replayed from the service worker, so the request has to
// be issued by the Flow page itself: mint a fresh captcha through the
// grecaptcha bridge, then run the batchexecute POST in the page's MAIN world,
// where `at` / `f.sid` / `bl` live.

const CAPTCHA_SLOT = '__CAPTCHA__';
const MAX_RPC_TEXT = 32000000; // the project listing alone is past 17 MB

async function runBatchRpc(cmd) {
  const tabs = await queryFlowTabs();
  let candidate = tabs.find((t) => !t.discarded) || tabs[0];
  if (!candidate) {
    // No Flow tab — open one and give the app a moment to boot, otherwise
    // WIZ_global_data is not on the page yet and `at` comes back empty. Hold
    // the exact created tab id so a redirect or a stale tab cannot hijack
    // the recovery.
    let opened;
    try {
      opened = await openFlowTabResilient(false);
      await sleep(5000);
      candidate = opened?.id ? await chrome.tabs.get(opened.id).catch(() => null) : null;
    } catch (e) {
      return { error: e?.message || 'NO_FLOW_TAB' };
    }
    if (!candidate) return { error: 'NO_FLOW_TAB' };
  }
  // Chrome discards backgrounded tabs; executeScript throws on a dead one.
  const tab = await reviveTabIfNeeded(candidate);
  if (!tab) return { error: 'FLOW_TAB_DISCARDED' };

  let freq = cmd.freq;
  if (cmd.captchaAction) {
    const solved = await solveCaptcha(cmd.id, cmd.captchaAction);
    if (!solved?.token) return { error: `CAPTCHA_FAILED: ${solved?.error || 'no token'}` };
    freq = freq.split(CAPTCHA_SLOT).join(solved.token);
  }

  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [cmd.rpcid, freq, MAX_RPC_TEXT, cmd.match || null],
    func: async (rpcid, freqStr, maxText, match) => {
      const wiz = globalThis.WIZ_global_data || {};
      const at = wiz.SNlM0e;
      const sid = wiz.FdrFJe;
      const bl = wiz.cfb2h;
      if (!at) return { error: 'NO_AT_TOKEN' };
      const reqid = Math.floor(Math.random() * 900000) + 100000;
      // Match Flow's own WIZ metadata. GEM_PIX_2 (Nano Banana Pro) rejects
      // image generation when source-path is missing, even where the lighter
      // models tolerate it.
      const sourcePath = location.pathname || '/';
      const hl = (document.documentElement.lang || navigator.language || 'en').split('-')[0];
      const url =
        `/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${encodeURIComponent(rpcid)}` +
        `&source-path=${encodeURIComponent(sourcePath)}` +
        `&bl=${encodeURIComponent(bl || '')}&f.sid=${encodeURIComponent(sid || '')}` +
        `&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: new URLSearchParams({ 'f.req': freqStr, at }),
      });
      const text = await resp.text();
      // The project listing is tens of megabytes and all we ever want from it
      // is one entry. Cutting it down in the page keeps that payload out of
      // the bridge on every poll — shipping it whole gets it truncated, which
      // loses roughly half of all lookups depending on where the id sorts.
      // Distinguish listing stubs (`["<id>",...`) from generation records
      // (`["<wf>","<proj>","<id>",null,null,[...`) so a null slot-3 record
      // never masks the listing stub, and return both windows when present.
      if (match) {
        const beforeWindow = 1024;
        const afterWindow = 4096;
        const collect = (needle) => {
          let listingHit = -1;
          let recordHit = -1;
          let otherHit = -1;
          let searchFrom = 0;
          while (searchFrom < text.length) {
            const idx = text.indexOf(needle, searchFrom);
            if (idx === -1) break;
            if (otherHit === -1) otherHit = idx;
            const before = text.slice(Math.max(0, idx - 6), idx);
            const after = text.slice(idx + needle.length, idx + needle.length + 24);
            const isListingHead =
              (before.endsWith('["') || before.endsWith('[\\"')) &&
              (after.startsWith('",') || after.startsWith('\\",'));
            const isRecordSlot2 =
              (before.endsWith(',"') || before.endsWith(',\\"')) &&
              (after.startsWith('",null,null,[') ||
                after.startsWith('\\",null,null,[') ||
                after.startsWith('","CAE",null,[') ||
                after.startsWith('\\",\\"CAE\\",null,['));
            if (listingHit === -1 && isListingHead) {
              listingHit = idx;
            } else if (recordHit === -1 && isRecordSlot2) {
              recordHit = idx;
            }
            if (listingHit !== -1 && recordHit !== -1) break;
            searchFrom = idx + needle.length;
          }
          return { listingHit, recordHit, otherHit };
        };
        let hits = collect(match);
        if (hits.listingHit === -1 && hits.recordHit === -1 && hits.otherHit === -1) {
          const lower = match.toLowerCase();
          if (lower !== match) hits = collect(lower);
        }
        const picks = [];
        if (hits.listingHit !== -1) picks.push(hits.listingHit);
        if (hits.recordHit !== -1) picks.push(hits.recordHit);
        if (picks.length === 0 && hits.otherHit !== -1) picks.push(hits.otherHit);
        picks.sort((a, b) => a - b);
        const ranges = [];
        for (const pos of picks) {
          const s = Math.max(0, pos - beforeWindow);
          const e = Math.min(text.length, pos + afterWindow);
          if (ranges.length > 0 && s <= ranges[ranges.length - 1][1]) {
            ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], e);
          } else {
            ranges.push([s, e]);
          }
        }
        return {
          status: resp.status,
          matched: ranges.length > 0,
          text: ranges.map(([s, e]) => text.slice(s, e)).join('\n'),
        };
      }
      return { status: resp.status, text: text.slice(0, maxText) };
    },
  });

  return injected?.result || { error: 'NO_INJECTION_RESULT' };
}

async function handleBatchRpc(msg) {
  const { id, params } = msg;
  const { rpcid, freq, captchaAction, match } = params || {};
  if (!rpcid || !freq) {
    sendToAgent({ id, status: 400, error: 'INVALID_BATCH_RPC' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;
  // Polls and listing lookups run constantly; only the generates are worth a
  // row in the log the popup shows.
  const visible = hasCaptcha;
  if (visible) {
    addRequestLog({
      id,
      type: `RPC:${rpcid}`,
      time: new Date().toISOString(),
      status: 'processing',
      error: null,
      url: rpcid,
      payloadSummary: freq.slice(0, 200),
    });
  }

  try {
    const out = await runBatchRpc({ id, rpcid, freq, captchaAction, match });
    if (out.error) {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = out.error; }
      if (visible) updateRequestLog(id, { status: 'failed', error: out.error });
      sendToAgent({ id, status: 502, error: out.error });
    } else {
      if (hasCaptcha) {
        metrics.successCount++;
        metrics.lastError = null;
        setTimeout(() => void syncCreditsFromFlowTab(true), 1200);
      }
      if (visible) {
        updateRequestLog(id, {
          status: 'success',
          httpStatus: out.status,
          responseSummary: (out.text || '').slice(0, 300),
        });
      }
      sendToAgent({ id, status: out.status, data: out.text });
    }
  } catch (e) {
    const err = e?.message || 'BATCH_RPC_FAILED';
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = err; }
    if (visible) updateRequestLog(id, { status: 'failed', error: err });
    sendToAgent({ id, status: 500, error: err });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── API Request Proxy (legacy) ─────────────────────────────
//
// The pre-migration REST path. aisandbox-pa required the `Bearer ya29.…`
// captured below, and flow.google.com does not mint one, so this answers
// NO_FLOW_KEY for real work now. Kept for the manual `proxy` request type,
// and so an extension updated ahead of its agent stays backwards compatible.

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params || {};

  if (!url || !url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, status: 400, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  addRequestLog({
    id,
    type:   classifyUrl(url),
    time:   new Date().toISOString(),
    status: 'processing',
    url,
  });

  try {
    // Step 0: Fail fast if we have no bearer token. Avoids burning a reCAPTCHA
    // solve (rate-limited + single-use) only to discover later that we can't
    // send the request.
    if (!flowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(id, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[Flowboard] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(id, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body clone if present
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    const fetchHeaders = { ...(headers || {}), authorization: `Bearer ${flowKey}` };

    const response = await fetch(url, {
      method:      method || 'POST',
      headers:     fetchHeaders,
      credentials: 'include',
      body:        method === 'GET' ? undefined : JSON.stringify(finalBody),
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    sendToAgent({ id, status: response.status, data: responseData });

    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(id, { status: 'success', httpStatus: response.status });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${response.status}`; }
      updateRequestLog(id, { status: 'failed', httpStatus: response.status, error: `API_${response.status}` });
    }
  } catch (e) {
    sendToAgent({ id, status: 500, error: e.message || 'API_REQUEST_FAILED' });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message || 'API_REQUEST_FAILED'; }
    updateRequestLog(id, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── Token Refresh (minimal) ────────────────────────────────

let _openingFlowTab = false;

const FLOW_URL = 'https://flow.google.com/';

/**
 * Open a Flow tab even when Chrome has zero windows. `chrome.tabs.create`
 * throws "No current window" in that state because it needs a window
 * context to attach to; `chrome.windows.create` spawns a fresh window
 * and tab in one call. Falls back through both paths so we recover from
 * "all-windows-closed but service-worker-still-alive" silently.
 */
async function openFlowTabResilient(active = false) {
  try {
    return await chrome.tabs.create({ url: FLOW_URL, active });
  } catch (e) {
    const msg = e?.message || '';
    if (!msg.includes('No current window')) throw e;
    console.log('[Flowboard] No Chrome window — spawning a fresh one for Flow');
    const win = await chrome.windows.create({
      url: FLOW_URL,
      focused: false,
      state: 'minimized',
    });
    return win.tabs?.[0] ?? null;
  }
}

async function captureTokenFromFlowTab() {
  const tabs = await queryFlowTabs();

  if (!tabs.length) {
    if (_openingFlowTab) return;
    _openingFlowTab = true;
    try {
      console.log('[Flowboard] No Flow tab — opening in background');
      await openFlowTabResilient(false);
    } catch (e) {
      console.error('[Flowboard] Failed to open Flow tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }

  try {
    // Trigger a credentialed request so the page re-issues an Authorization header
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func:   () => fetch('/fx/tools/flow', { credentials: 'include' }),
    });
    console.log('[Flowboard] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[Flowboard] Token refresh failed:', e);
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    // Inject content script and retry. Both the inject + re-send can
    // throw "No current window" / "No tab with id" if the tab dies in
    // between (Chrome aggressively discards background tabs). Surface
    // those verbatim so solveCaptcha's loop can move to the next
    // candidate instead of bubbling a confusing message to the user.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  }
}

/** Try to wake a discarded Flow tab so `sendMessage` can reach it.
 *  Chrome auto-discards backgrounded tabs to save memory; the tab still
 *  shows up in `chrome.tabs.query` but cross-context calls fail with
 *  "No current window" / "No tab with id". A reload re-hydrates it. */
async function reviveTabIfNeeded(tab) {
  if (!tab?.discarded) return tab;
  try {
    await chrome.tabs.reload(tab.id);
    await sleep(2500);
    const fresh = await chrome.tabs.get(tab.id);
    return fresh;
  } catch {
    return null;
  }
}

function captchaFromTab(tabId, requestId, captchaAction) {
  return Promise.race([
    requestCaptchaFromTab(tabId, requestId, captchaAction),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
  ]);
}

async function solveCaptcha(requestId, captchaAction) {
  const tabs = await queryFlowTabs();

  // No Flow tab at all — spawn one (handles "no Chrome window" via the
  // resilient helper).
  if (!tabs.length) {
    try {
      await openFlowTabResilient(false);
      await sleep(3000);
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
  }

  // Try each Flow tab in turn — gracefully skip dead/discarded ones
  // instead of bubbling "No current window" up to the user. Re-query
  // because we might have just spawned a new one above.
  const candidates = await queryFlowTabs();
  const errors = [];
  for (const tab of candidates) {
    const live = await reviveTabIfNeeded(tab);
    if (!live) continue;
    try {
      const resp = await captchaFromTab(live.id, requestId, captchaAction);
      // A tab that replies without a token is a tab sitting on a page that
      // never loaded grecaptcha — another Flow tab may well be fine. Returning
      // on the first reply let one stale tab veto every generation.
      if (!resp?.token) {
        errors.push(resp?.error || 'NO_TOKEN');
        continue;
      }
      return resp;
    } catch (e) {
      const msg = e?.message || '';
      errors.push(msg);
      // Tab evaporated mid-call (window closed, tab discarded again,
      // or page navigated away). Move on to the next candidate.
      if (
        msg.includes('No current window') ||
        msg.includes('No tab with id') ||
        msg.includes('Receiving end does not exist')
      ) {
        continue;
      }
      return { error: msg };
    }
  }

  // All candidates failed — last-ditch: spawn a fresh Flow tab and try THAT
  // exact tab once. This handles every existing Flow tab being in a window we
  // could not recover from. Previously this re-queried all Flow tabs and took
  // fresh[0], which could pick the same stale tab again while leaking the
  // newly created one on every retry.
  let recoveryTab = null;
  try {
    recoveryTab = await openFlowTabResilient(false);
    await sleep(3000);
    const target = recoveryTab?.id
      ? await chrome.tabs.get(recoveryTab.id).catch(() => null)
      : null;
    if (!target || target.discarded) return { error: 'NO_FLOW_TAB' };
    return await captchaFromTab(target.id, requestId, captchaAction);
  } catch (e) {
    return { error: e?.message || errors[0] || 'NO_FLOW_TAB' };
  } finally {
    // A recovery tab is disposable: there were already Flow tabs available for
    // the signed RPC itself. Do not let captcha retries accumulate tabs.
    if (recoveryTab?.id) {
      try { await chrome.tabs.remove(recoveryTab.id); } catch { /* already gone */ }
    }
  }
}

// ─── TRPC Request Proxy ─────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  // Tightly scoped to TRPC endpoints — prevents the agent from navigating to
  // arbitrary labs.google paths (e.g. /fx/api/trpc/account.deleteAccount would
  // also match /fx/api/trpc/ but account-level mutations should be gated server
  // side if they're ever needed).
  if (!url || !url.startsWith('https://labs.google/fx/api/trpc/')) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls are silent — don't add to request log, don't bump metrics

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body:    body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await resp.json();
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[Flowboard] tRPC request failed:', e);
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

// ─── Google Flow Music Bridge (Personal Credits Channel) ────

// In-memory only (NEVER persisted to chrome.storage.local; NEVER touches refresh_token).
let capturedFlowMusicSession = null;

function decodeBase64UrlToUtf8(b64) {
  let norm = String(b64 || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/g, '');
  if (!norm) throw new Error('EMPTY_BASE64');
  const pad = (4 - (norm.length % 4)) % 4;
  if (pad) norm += '='.repeat(pad);
  const bin = atob(norm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function safeDecodeUriComponent(raw) {
  if (typeof raw !== 'string') return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw.replace(/%[0-9A-Fa-f]{2}/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
  }
}

function parseJwtPayload(accessToken) {
  try {
    const parts = String(accessToken || '').trim().split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(decodeBase64UrlToUtf8(parts[1]));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function normalizeEpochSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
}

function buildFlowMusicSessionFromJwt(accessToken, userHint = null, explicitExpiresAt = null) {
  if (typeof accessToken !== 'string') return null;
  const token = accessToken.trim();
  if (token.length < 20) return null;

  const payload = parseJwtPayload(token);
  // Reject public Supabase anon keys (`role === 'anon'`) and anonymous sessions.
  if (payload?.role === 'anon' || payload?.is_anonymous === true) return null;
  if (userHint?.is_anonymous === true) return null;

  const expiresAt =
    normalizeEpochSeconds(explicitExpiresAt) ??
    normalizeEpochSeconds(payload?.exp);
  const userId =
    (typeof userHint?.id === 'string' && userHint.id) ||
    (typeof payload?.sub === 'string' && payload.sub) ||
    null;
  const email =
    (typeof userHint?.email === 'string' && userHint.email) ||
    (typeof userHint?.user_metadata?.email === 'string' && userHint.user_metadata.email) ||
    (typeof payload?.email === 'string' && payload.email) ||
    (typeof payload?.user_metadata?.email === 'string' && payload.user_metadata.email) ||
    null;

  // Deliberately NEVER forward refresh_token: only the browser's own Supabase
  // client rotates single-use refresh tokens so tabs and agent never collide.
  return {
    access_token: token,
    expires_at: expiresAt,
    user_id: userId,
    email,
  };
}

function stripOuterQuotes(text) {
  const t = String(text || '').trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function extractSafeFlowMusicSession(rawInput, depth = 0) {
  if (depth > 2 || rawInput === null || rawInput === undefined) return null;

  let parsed = null;
  if (typeof rawInput === 'object') {
    parsed = rawInput;
  } else if (typeof rawInput === 'string') {
    const trimmed = stripOuterQuotes(rawInput);
    if (!trimmed) return null;

    // Bare JWT string fallback
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
      return buildFlowMusicSessionFromJwt(trimmed);
    }

    const candidates = [trimmed];
    if (trimmed.includes('%')) {
      const decoded = stripOuterQuotes(safeDecodeUriComponent(trimmed));
      if (decoded && decoded !== trimmed) candidates.unshift(decoded);
    }

    for (const candidate of candidates) {
      let jsonStr = candidate;
      if (jsonStr.startsWith('base64-')) {
        try {
          jsonStr = decodeBase64UrlToUtf8(jsonStr.slice(7));
        } catch {
          continue;
        }
      }
      try {
        const obj = JSON.parse(jsonStr);
        if (typeof obj === 'string') {
          const inner = extractSafeFlowMusicSession(obj, depth + 1);
          if (inner) return inner;
          continue;
        }
        if (obj && typeof obj === 'object') {
          parsed = obj;
          break;
        }
      } catch {
        // try next candidate
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed)) {
    return typeof parsed[0] === 'string' ? buildFlowMusicSessionFromJwt(parsed[0]) : null;
  }

  const objectsToCheck = [
    parsed,
    parsed.session,
    parsed.currentSession,
    parsed.data?.session,
    parsed.data,
  ];
  for (const obj of objectsToCheck) {
    if (!obj || typeof obj !== 'object') continue;
    if (typeof obj.access_token === 'string' && obj.access_token) {
      const session = buildFlowMusicSessionFromJwt(
        obj.access_token,
        obj.user || parsed.user || null,
        obj.expires_at ?? parsed.expires_at ?? null,
      );
      if (session) return session;
    }
  }
  return null;
}

function isFlowMusicSessionFresh(session, marginSec = 60) {
  if (!session?.access_token) return false;
  if (typeof session.expires_at !== 'number') return true;
  return session.expires_at > Math.floor(Date.now() / 1000) + marginSec;
}

function registerFlowMusicBearerSniffer() {
  if (!chrome.webRequest?.onBeforeSendHeaders?.addListener) return;
  const listener = (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!/^Bearer\s+/i.test(value)) return;
    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token || token.startsWith('ya29.')) return;
    const session = buildFlowMusicSessionFromJwt(token);
    if (session && isFlowMusicSessionFresh(session, 15)) {
      capturedFlowMusicSession = session;
    }
  };
  const filter = {
    urls: [
      'https://www.flowmusic.app/__api/*',
      'https://flowmusic.app/__api/*',
      'https://*.flowmusic.app/__api/*',
    ],
  };
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(listener, filter, ['requestHeaders', 'extraHeaders']);
  } catch {
    try {
      chrome.webRequest.onBeforeSendHeaders.addListener(listener, filter, ['requestHeaders']);
    } catch {
      // non-fatal
    }
  }
}

registerFlowMusicBearerSniffer();

function parseFlowMusicCookieName(name) {
  const n = String(name || '').trim();
  // Primary Supabase SSR pattern (supports __Secure-/__Host- prefixes and dots in project key)
  const primary = n.match(/^((?:__(?:Secure|Host)-)?sb-.+?-auth-token)(?:\.(\d+))?$/);
  if (primary) {
    return {
      base: primary[1],
      index: primary[2] !== undefined ? Number(primary[2]) : -1,
      primary: true,
    };
  }
  // Secondary catch-all for renamed/alternative session cookies
  const secondary = n.match(/^(.+?)(?:\.(\d+))?$/);
  if (secondary && /(auth|session|token)/i.test(secondary[1])) {
    return {
      base: secondary[1],
      index: secondary[2] !== undefined ? Number(secondary[2]) : -1,
      primary: false,
    };
  }
  return null;
}

function selectBestFlowMusicSessionFromCookies(cookieList) {
  if (!Array.isArray(cookieList) || cookieList.length === 0) return null;

  // Group strictly per (storeId, domain, path, partition, baseName) so chunks from
  // different subdomains (e.g. www.flowmusic.app vs .flowmusic.app) NEVER corrupt each other.
  const groups = new Map();
  for (const c of cookieList) {
    if (!c?.name || typeof c.value !== 'string' || !c.value) continue;
    let parsedName = parseFlowMusicCookieName(c.name);
    if (!parsedName && (c.value.startsWith('base64-') || c.value.startsWith('eyJ'))) {
      parsedName = { base: c.name, index: -1, primary: false };
    }
    if (!parsedName) continue;

    const partTop = c.partitionKey?.topLevelSite || '';
    const groupKey = `${c.storeId || ''}::${c.domain || ''}::${c.path || '/'}::${partTop}::${parsedName.base}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        domain: c.domain || '',
        primary: parsedName.primary,
        unchunked: [],
        numbered: [],
      });
    }
    const g = groups.get(groupKey);
    if (parsedName.index < 0) {
      g.unchunked.push(c.value);
    } else {
      g.numbered.push([parsedName.index, c.value]);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let best = null;
  let bestScore = -Infinity;

  const consider = (session, meta) => {
    if (!session?.access_token) return;
    const fresh = !session.expires_at || session.expires_at > nowSec + 30;
    let score = (fresh ? 1000 : 0) + (meta.primary ? 200 : 0);
    if (meta.domain.includes('flowmusic.app')) score += 50;
    if (typeof session.expires_at === 'number') {
      score += Math.min(100, Math.max(-100, (session.expires_at - nowSec) / 60));
    }
    if (score > bestScore) {
      bestScore = score;
      best = session;
    }
  };

  for (const g of groups.values()) {
    for (const singleVal of g.unchunked) {
      consider(extractSafeFlowMusicSession(singleVal), g);
    }
    if (g.numbered.length > 0) {
      g.numbered.sort((a, b) => a[0] - b[0]);
      const rawJoined = g.numbered.map(([, v]) => v).join('');
      const decodedJoined = g.numbered.map(([, v]) => safeDecodeUriComponent(v)).join('');
      const unquotedJoined = g.numbered.map(([, v]) => stripOuterQuotes(v)).join('');
      const tries = Array.from(new Set([rawJoined, decodedJoined, unquotedJoined]));
      for (const joined of tries) {
        const session = extractSafeFlowMusicSession(joined);
        if (session) {
          consider(session, g);
          break;
        }
      }
    }
  }

  return best;
}

async function queryFlowMusicCookies(preferredTab = null) {
  if (!chrome.cookies?.getAll) {
    return { available: false, cookies: [] };
  }

  const storeIds = new Set([undefined]);
  if (chrome.cookies.getAllCookieStores) {
    const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
    if (preferredTab?.id && Array.isArray(stores)) {
      const tabStore = stores.find((s) => Array.isArray(s.tabIds) && s.tabIds.includes(preferredTab.id));
      if (tabStore?.id) storeIds.add(tabStore.id);
    }
  }

  const baseQueries = [
    { url: FLOWMUSIC_ORIGIN + '/' },
    { url: 'https://flowmusic.app/' },
    { domain: 'flowmusic.app' },
    { domain: 'sb.flowmusic.app' },
    { url: FLOWMUSIC_ORIGIN + '/', partitionKey: {} },
    { domain: 'flowmusic.app', partitionKey: {} },
  ];
  if (typeof preferredTab?.url === 'string' && preferredTab.url.startsWith('https://') && preferredTab.url.includes('flowmusic.app')) {
    baseQueries.unshift({ url: preferredTab.url });
  }

  const dedup = new Map();
  for (const storeId of storeIds) {
    for (const q of baseQueries) {
      const query = storeId ? { ...q, storeId } : q;
      const list = await chrome.cookies.getAll(query).catch(() => []);
      for (const c of list || []) {
        if (!c?.name) continue;
        const partTop = c.partitionKey?.topLevelSite || '';
        const key = `${c.storeId || ''}::${c.domain || ''}::${c.path || '/'}::${partTop}::${c.name}`;
        if (!dedup.has(key)) dedup.set(key, c);
      }
    }
  }

  return { available: true, cookies: Array.from(dedup.values()) };
}

async function readFlowMusicSessionFromCookies(preferredTab = null) {
  const { cookies } = await queryFlowMusicCookies(preferredTab);
  return selectBestFlowMusicSessionFromCookies(cookies);
}

async function readFlowMusicSessionFromTab(tab) {
  if (!tab?.id) return null;
  const live = await reviveTabIfNeeded(tab);
  if (!live?.id) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: live.id },
      world: 'MAIN',
      func: async () => {
        const cookiePairs = [];
        try {
          const rawCookie = document.cookie || '';
          for (const part of rawCookie.split(';')) {
            const idx = part.indexOf('=');
            if (idx > 0) {
              cookiePairs.push({
                name: part.slice(0, idx).trim(),
                value: part.slice(idx + 1).trim(),
                domain: location.hostname,
                path: '/',
              });
            }
          }
        } catch {}

        const storageCandidates = [];
        const scanStorage = (store) => {
          try {
            for (let i = 0; i < store.length; i++) {
              const k = store.key(i);
              if (!k) continue;
              const v = store.getItem(k);
              if (!v || v.length > 65536) continue;
              if (
                /(sb-|auth|supabase|session|token|flowmusic|producer)/i.test(k) ||
                v.startsWith('base64-') ||
                v.includes('access_token')
              ) {
                storageCandidates.push(v);
              }
            }
          } catch {}
        };
        scanStorage(window.localStorage);
        scanStorage(window.sessionStorage);

        let apiSession = null;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 4000);
          const resp = await fetch('/__api/auth/session', {
            credentials: 'include',
            headers: { Accept: 'application/json' },
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (resp.ok) {
            apiSession = await resp.json().catch(() => null);
          }
        } catch {}

        return { cookiePairs, storageCandidates, apiSession };
      },
    });

    const bundle = res?.result;
    if (!bundle || typeof bundle !== 'object') return null;

    // 1. Reconstruct chunked Supabase SSR cookies directly from document.cookie
    if (Array.isArray(bundle.cookiePairs) && bundle.cookiePairs.length > 0) {
      const fromDocCookie = selectBestFlowMusicSessionFromCookies(bundle.cookiePairs);
      if (fromDocCookie) return fromDocCookie;
    }

    // 2. Inspect localStorage / sessionStorage candidates
    if (Array.isArray(bundle.storageCandidates)) {
      for (const raw of bundle.storageCandidates) {
        const session = extractSafeFlowMusicSession(raw);
        if (session) return session;
      }
    }

    // 3. Inspect /__api/auth/session JSON if returned
    if (bundle.apiSession) {
      const fromApi = extractSafeFlowMusicSession(bundle.apiSession);
      if (fromApi) return fromApi;
    }
  } catch {
    // non-fatal
  }
  return null;
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const existing = await chrome.tabs.get(tabId).catch(() => null);
  if (existing?.status === 'complete') return;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function ensureFlowMusicTab(active = false) {
  const tabs = await queryFlowMusicTabs();
  const live = tabs.find((t) => !t.discarded) || tabs[0];
  if (live?.id) {
    if (active) {
      await chrome.tabs.update(live.id, { active: true }).catch(() => {});
      if (live.windowId) {
        await chrome.windows.update(live.windowId, { focused: true }).catch(() => {});
      }
    }
    return live;
  }
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const tab = win?.id
    ? await chrome.tabs.create({ windowId: win.id, url: FLOWMUSIC_ORIGIN + '/', active })
    : await chrome.tabs.create({ url: FLOWMUSIC_ORIGIN + '/', active });
  if (tab?.id) {
    await waitForTabComplete(tab.id, 15000);
  }
  queuePresenceUpdate();
  return tab;
}

async function readFlowMusicAccessToken({ allowTabFallback = true } = {}) {
  // 1. Live Bearer JWT passively sniffed from flowmusic.app/__api/* requests
  if (isFlowMusicSessionFresh(capturedFlowMusicSession, 60)) {
    return capturedFlowMusicSession;
  }

  const tabs = await queryFlowMusicTabs().catch(() => []);
  const preferredTab = tabs.find((t) => !t.discarded && t.id) || tabs[0] || null;

  // 2. Chrome cookies API (grouped strictly per host/path/store/partition)
  const fromCookie = await readFlowMusicSessionFromCookies(preferredTab);
  if (fromCookie && isFlowMusicSessionFresh(fromCookie, 60)) {
    return fromCookie;
  }

  // 3. In-tab MAIN-world fallback (document.cookie, localStorage/sessionStorage, /__api/auth/session)
  let fromTab = null;
  if (allowTabFallback && preferredTab?.id) {
    fromTab = await readFlowMusicSessionFromTab(preferredTab);
    if (fromTab && isFlowMusicSessionFresh(fromTab, 60)) {
      return fromTab;
    }
  }

  // Return an expired session if one exists so callers know to trigger a tab refresh.
  return fromCookie || fromTab || capturedFlowMusicSession || null;
}

async function collectFlowMusicDiagnostics() {
  const tabs = await queryFlowMusicTabs().catch(() => []);
  const { available, cookies } = await queryFlowMusicCookies(tabs[0] || null).catch(() => ({
    available: false,
    cookies: [],
  }));
  // Safe metadata only: cookie NAMES (never values) and origins/counts.
  const cookieNames = Array.from(new Set((cookies || []).map((c) => c?.name).filter(Boolean))).slice(0, 25);
  const tabOrigins = tabs.slice(0, 3).map((t) => {
    try {
      return new URL(t.url || '').origin;
    } catch {
      return '';
    }
  });
  return {
    ext_version: chrome.runtime.getManifest?.()?.version || 'unknown',
    has_cookies_api: available,
    tab_count: tabs.length,
    tab_origins: tabOrigins,
    cookie_names: cookieNames,
    has_captured_bearer: Boolean(capturedFlowMusicSession?.access_token),
  };
}

async function handleFlowMusicOpen(msg) {
  const { id, params = {} } = msg;
  try {
    const active = params.active !== false;
    const tab = await ensureFlowMusicTab(active);
    const session = await readFlowMusicAccessToken({ allowTabFallback: true });
    sendMusicReply({
      id,
      ok: true,
      tab_id: tab?.id || null,
      music_tab_open: true,
      signed_in: !!session,
      email: session?.email || null,
    });
  } catch (e) {
    sendMusicReply({ id, error: e?.message || 'FLOWMUSIC_OPEN_FAILED' });
  }
}

async function handleFlowMusicGetToken(msg) {
  const { id, params = {} } = msg;
  try {
    let session = await readFlowMusicAccessToken({ allowTabFallback: true });
    const expired = session && !isFlowMusicSessionFresh(session, 60);
    if ((!session || expired) && params.refreshIfExpired) {
      const refreshed = await refreshFlowMusicSessionInBrowser(false);
      if (refreshed) session = refreshed;
    }
    if (!session) {
      const diag = await collectFlowMusicDiagnostics();
      sendMusicReply({ id, error: 'FLOWMUSIC_NOT_LOGGED_IN', diag });
      return;
    }
    sendMusicReply({ id, ok: true, ...session });
  } catch (e) {
    sendMusicReply({ id, error: e?.message || 'FLOWMUSIC_TOKEN_FAILED' });
  }
}

async function refreshFlowMusicSessionInBrowser(active = false) {
  const tab = await ensureFlowMusicTab(active);
  if (!tab?.id) return null;
  await chrome.tabs.reload(tab.id).catch(() => {});
  await waitForTabComplete(tab.id, 15000);
  // Give Supabase JS client + webRequest sniffer a short window to capture a fresh token.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const session = await readFlowMusicAccessToken({ allowTabFallback: true });
    if (session && isFlowMusicSessionFresh(session, 60)) {
      return session;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return await readFlowMusicAccessToken({ allowTabFallback: true });
}

async function handleFlowMusicRefreshSession(msg) {
  const { id, params = {} } = msg;
  try {
    const session = await refreshFlowMusicSessionInBrowser(Boolean(params.active));
    if (!session) {
      const diag = await collectFlowMusicDiagnostics();
      sendMusicReply({ id, error: 'FLOWMUSIC_NOT_LOGGED_IN', diag });
      return;
    }
    sendMusicReply({ id, ok: true, ...session });
  } catch (e) {
    sendMusicReply({ id, error: e?.message || 'FLOWMUSIC_REFRESH_FAILED' });
  }
}

async function handleFlowMusicFetch(msg) {
  const { id, params = {} } = msg;
  const path = typeof params.path === 'string' ? params.path : '';
  const method = (typeof params.method === 'string' ? params.method : 'GET').toUpperCase();
  if (!path.startsWith('/__api/')) {
    sendMusicReply({ id, status: 400, error: 'INVALID_FLOWMUSIC_PATH' });
    return;
  }
  try {
    const tab = await ensureFlowMusicTab(false);
    const live = await reviveTabIfNeeded(tab);
    if (!live?.id) {
      sendMusicReply({ id, status: 502, error: 'NO_FLOWMUSIC_TAB' });
      return;
    }
    const session = await readFlowMusicAccessToken({ allowTabFallback: true });
    if (!session?.access_token && !params.allowCookieOnly) {
      const diag = await collectFlowMusicDiagnostics();
      sendMusicReply({ id, status: 401, error: 'FLOWMUSIC_NOT_LOGGED_IN', diag });
      return;
    }
    const [executed] = await chrome.scripting.executeScript({
      target: { tabId: live.id },
      world: 'MAIN',
      args: [path, method, session?.access_token || '', params.body ?? null, Boolean(params.asText)],
      func: async (reqPath, reqMethod, token, reqBody, asText) => {
        try {
          const headers = {
            Accept: asText ? 'text/event-stream, application/json, */*' : 'application/json',
          };
          if (token) {
            headers.Authorization = `Bearer ${token}`;
          }
          let body;
          if (reqBody !== null && reqBody !== undefined && reqMethod !== 'GET' && reqMethod !== 'HEAD') {
            headers['Content-Type'] = 'application/json';
            body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
          }
          const resp = await fetch(reqPath, {
            method: reqMethod,
            headers,
            body,
            credentials: 'include',
          });
          const text = await resp.text();
          if (asText) {
            return { status: resp.status, text };
          }
          let data = null;
          try { data = JSON.parse(text); } catch { data = text; }
          return { status: resp.status, data };
        } catch (err) {
          return { error: err?.message || 'FLOWMUSIC_PAGE_FETCH_FAILED' };
        }
      },
    });
    const out = executed?.result || { error: 'EMPTY_FLOWMUSIC_FETCH' };
    sendMusicReply({ id, ...out });
  } catch (e) {
    sendMusicReply({ id, error: e?.message || 'FLOWMUSIC_FETCH_FAILED' });
  }
}

if (chrome.cookies?.onChanged) {
  chrome.cookies.onChanged.addListener((changeInfo) => {
    const dom = changeInfo?.cookie?.domain || '';
    const name = changeInfo?.cookie?.name || '';
    if (dom.includes('flowmusic.app') && /auth-token/i.test(name)) {
      if (changeInfo.removed) {
        capturedFlowMusicSession = null;
      }
      queuePresenceUpdate();
    }
  });
}

// ─── State & Badge ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors  = { idle: '#22c55e', running: '#f5b301', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[newState] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[newState] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

// ─── Popup Message Handlers ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'PAIR_PROFILE') {
    // Only an extension UI may forward a user-entered code; tabs/content scripts may not.
    if (sender.url !== chrome.runtime.getURL('popup.html')) return;
    const code = typeof msg.code === 'string' ? msg.code.trim() : '';
    if (!code || code.length > 128) {
      reply({ error: '请输入画布设置中显示的配对码。' });
    } else if (!profileHelloSocket || profileHelloSocket !== ws || ws.readyState !== WebSocket.OPEN) {
      connectToAgent();
      reply({ error: '本地服务尚未连接，请确认 Agent 已启动后重试。' });
    } else if (pendingPair) {
      reply({ error: '正在配对，请稍候。' });
    } else {
      const timer = setTimeout(() => finishPair({ error: '本地服务未确认配对。请确认 Agent 已更新，再生成新配对码。' }), 8000);
      pendingPair = { reply, timer };
      ws.send(JSON.stringify({ type: 'profile_pair', code }));
      return true;
    }
    return;
  }

  if (msg.type === 'STATUS') {
    connectToAgent();
    reply({
      connected:       !!profileHelloSocket && profileHelloSocket === ws && ws?.readyState === WebSocket.OPEN,
      paired:          !!profileId,
      flowKeyPresent:  !!flowKey,
      manualDisconnect,
      tokenAge:        metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount:  metrics.failedCount,
        lastError:    metrics.lastError,
      },
      state,
    });
    return true;
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    ws?.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    queryFlowTabs().then(async (tabs) => {
      try {
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          reply({ ok: true, tabId: tabs[0].id });
        } else {
          // User-initiated → focus the new window so they can see it.
          const tab = await openFlowTabResilient(true);
          reply({ ok: true, tabId: tab?.id });
        }
      } catch (e) {
        reply({ error: e.message });
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  return true;
});

console.log('[Flowboard] Extension loaded');
