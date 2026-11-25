// Run from frontend: node --test tests/flow-music.test.mjs
// Covers Flow Music personal-channel constants, labels, director skills,
// persistent timeline BGM state, and generation + 4-stem split polling lifecycle.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

test("Flow Music models, credit estimates, node labels, and director skills", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, logLevel: "error" });
  try {
    const models = await server.ssrLoadModule("/src/constants/models.ts");
    const labels = await server.ssrLoadModule("/src/constants/nodeLabels.ts");
    const skills = await server.ssrLoadModule("/src/constants/directorSkills.ts");

    assert.equal(models.MUSIC_MODEL_CATALOG.length, 2);
    assert.equal(models.MUSIC_MODEL_CATALOG[0].id, "Lyria 3.5");
    assert.equal(models.estimateMusicCreditCost("gen_music").total, 5);
    assert.equal(models.estimateMusicCreditCost("edit_music").total, 5);
    assert.equal(models.estimateMusicCreditCost("split_stems").total, 0);
    assert.equal(models.estimateMusicCreditCost("split_stems").isZero, true);
    assert.equal(models.estimateMusicCreditCost("effect_music").total, 0);
    assert.equal(models.estimateMusicCreditCost("lyrics").total, 0);

    assert.equal(labels.displayNodeTitle("", "audio"), "音频");
    assert.equal(labels.displayNodeTitle("Audio", "audio"), "音频");

    const musicMatches = skills.filterDirectorSkills("一键配乐");
    assert.equal(musicMatches.length, 1);
    assert.deepEqual(musicMatches[0].action, { kind: "open_audio_director", tab: "ai_music" });

    const stemMatches = skills.filterDirectorSkills("分轨");
    assert.ok(stemMatches.some((s) => s.id === "stem_separation"));
  } finally {
    await server.close();
  }
});

test("timelineAudio persists /media/ BGM asset and updates fade-out duration", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, logLevel: "error" });
  const backing = new Map();
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  try {
    const { useTimelineAudioStore } = await server.ssrLoadModule("/src/store/timelineAudio.ts");
    useTimelineAudioStore.getState().setBgmMediaAsset({
      mediaId: "audio-mid-1",
      name: "霓虹雨夜 · 主题配乐",
      url: "/media/audio-mid-1",
    });
    useTimelineAudioStore.getState().setBgmFadeOutSec(3.5);

    const st = useTimelineAudioStore.getState();
    assert.equal(st.bgmMediaId, "audio-mid-1");
    assert.equal(st.bgmUrl, "/media/audio-mid-1");
    assert.equal(st.bgmFadeOutSec, 3.5);
    assert.ok(backing.get("flowboard.timelineBgm.v1")?.includes("audio-mid-1"));

    useTimelineAudioStore.getState().setBgmMediaAsset(null);
    assert.equal(useTimelineAudioStore.getState().bgmMediaId, null);
    assert.equal(backing.has("flowboard.timelineBgm.v1"), false);
  } finally {
    globalThis.localStorage = prevStorage;
    await server.close();
  }
});

test("dispatchMusicGeneration and dispatchMusicSplitStems preserve primary mediaId and stamp stems", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, logLevel: "error" });
  const savedFetch = globalThis.fetch;
  let gen;
  try {
    const { useBoardStore: board } = await server.ssrLoadModule("/src/store/board.ts");
    const { useGenerationStore } = await server.ssrLoadModule("/src/store/generation.ts");
    gen = useGenerationStore;
    const { useFlowAccounts: accounts } = await server.ssrLoadModule("/src/store/flowAccounts.ts");

    accounts.getState().apply({
      accounts: [
        {
          id: "acc-music",
          label: "主账号",
          project_id: null,
          credits: null,
          music_credits: 120,
          music_plan: "AI Pro",
          music_tab_open: true,
          connected: true,
          flow_tab_open: false,
          paygate_tier: null,
        },
      ],
      active_account_id: "acc-music",
      extension_path: "",
    });

    board.setState({
      boardId: 1,
      nodes: [
        {
          id: "9",
          type: "audio",
          position: { x: 0, y: 0 },
          data: {
            type: "audio",
            title: "音频",
            shortId: "A9",
            status: "idle",
          },
        },
      ],
      edges: [],
    });

    const submitted = [];
    globalThis.fetch = async (url, options) => {
      if (url === "/api/requests" && options?.method === "POST") {
        const body = JSON.parse(options.body);
        submitted.push(body);
        return Response.json({ id: body.type === "gen_music" ? 101 : 102, status: "queued" });
      }
      if (url === "/api/requests/101") {
        return Response.json({
          id: 101,
          status: "done",
          type: "gen_music",
          params: { prompt: "cinematic strings" },
          result: {
            media_ids: ["aud-a", "aud-b"],
            clip_id: "clip-a",
            clip_ids: ["clip-a", "clip-b"],
            music_title: "片尾交响曲",
            music_model: "Lyria 3.5",
            music_bpm: 96,
            music_duration_s: 90,
            music_instrumental: true,
          },
        });
      }
      if (url === "/api/requests/102") {
        return Response.json({
          id: 102,
          status: "done",
          type: "split_stems",
          params: { clip_id: "clip-a", media_id: "aud-a" },
          result: {
            media_ids: ["aud-a"],
            clip_id: "clip-a",
            preserve_primary_media: true,
            stems: {
              vocals: "stem-v",
              drums: "stem-d",
              bass: "stem-b",
              other: "stem-o",
            },
          },
        });
      }
      if (String(url).startsWith("/api/nodes/9") && options?.method === "PATCH") {
        return Response.json({});
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const waitFor = async (pred) => {
      for (let i = 0; i < 80; i++) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.fail("Timed out waiting for music task completion");
    };

    await gen.getState().dispatchMusicGeneration("9", {
      prompt: "cinematic strings",
      instrumental: true,
      durationSeconds: 90,
      bpm: 96,
      musicModel: "Lyria 3.5",
    });
    await waitFor(() => board.getState().nodes[0].data.status === "done");

    let nodeData = board.getState().nodes[0].data;
    assert.equal(submitted[0].type, "gen_music");
    assert.equal(submitted[0].flow_account_id, "acc-music");
    assert.equal(nodeData.mediaId, "aud-a");
    assert.deepEqual(nodeData.mediaIds, ["aud-a", "aud-b"]);
    assert.equal(nodeData.musicClipId, "clip-a");
    assert.equal(nodeData.musicTitle, "片尾交响曲");

    await gen.getState().dispatchMusicSplitStems("9", "clip-a");
    await waitFor(() => Boolean(board.getState().nodes[0].data.musicStems?.other));

    nodeData = board.getState().nodes[0].data;
    assert.equal(submitted[1].type, "split_stems");
    assert.equal(nodeData.mediaId, "aud-a");
    assert.equal(nodeData.musicStems.vocals, "stem-v");
    assert.equal(nodeData.musicStems.other, "stem-o");
  } finally {
    gen?.getState().cancelGeneration("9");
    globalThis.fetch = savedFetch;
    await server.close();
  }
});

test("extension/background.js extracts Flow Music session cleanly across subdomains, chunk encodings, and webRequest", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const vm = await import("node:vm");

  const bgPath = path.resolve(process.cwd(), "..", "extension", "background.js");
  const bgSource = fs.readFileSync(bgPath, "utf8");

  const webRequestListeners = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextDecoder,
    atob,
    fetch: async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({}) }),
    WebSocket: class {
      constructor() {
        this.readyState = 3;
      }
      send() {}
      close() {}
    },
    chrome: {
      runtime: {
        onInstalled: { addListener: noop },
        onStartup: { addListener: noop },
        onMessage: { addListener: noop },
        sendMessage: async () => {},
        getManifest: () => ({ version: "0.1.6" }),
        getURL: (p) => `chrome-extension://test/${p}`,
      },
      alarms: {
        onAlarm: { addListener: noop },
        create: noop,
        clear: noop,
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
        },
      },
      tabs: {
        query: async () => [],
        get: async () => null,
        create: async () => null,
        update: async () => null,
        reload: async () => null,
        onCreated: { addListener: noop },
        onRemoved: { addListener: noop },
        onReplaced: { addListener: noop },
        onUpdated: { addListener: noop, removeListener: noop },
      },
      windows: {
        getLastFocused: async () => null,
        update: async () => null,
      },
      action: {
        setBadgeText: noop,
        setBadgeBackgroundColor: noop,
      },
      webRequest: {
        onBeforeSendHeaders: {
          addListener: (fn, filter) => webRequestListeners.push({ fn, filter }),
        },
      },
      cookies: {
        getAll: async () => [],
        getAllCookieStores: async () => [],
        onChanged: { addListener: noop },
      },
      scripting: {
        executeScript: async () => [],
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${bgSource}\nglobalThis.__fmTest = { extractSafeFlowMusicSession, selectBestFlowMusicSessionFromCookies, buildFlowMusicSessionFromJwt, getCaptured: () => capturedFlowMusicSession };`,
    sandbox,
  );
  const fm = sandbox.__fmTest;

  const makeJwt = (payloadObj) => {
    const hdr = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const pay = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
    return `${hdr}.${pay}.sig1234567890`;
  };

  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const userJwt = makeJwt({ sub: "u-42", email: "valley@example.com", role: "authenticated", exp: futureExp });
  const anonJwt = makeJwt({ ref: "ednjccqcmbxeaxbidinr", role: "anon", exp: futureExp + 10000 });

  // 1. Public Supabase anon JWT must be rejected
  assert.equal(fm.buildFlowMusicSessionFromJwt(anonJwt), null);

  // 2. Cross-domain cookie chunk collision: www.flowmusic.app has stale anonymous .0,
  //    while .flowmusic.app has real 2-chunk Google OAuth session (.0 + .1)
  const validPayload = JSON.stringify({
    access_token: userJwt,
    refresh_token: "SECRET_REFRESH_MUST_NOT_LEAK",
    expires_at: futureExp,
    user: { id: "u-42", email: "valley@example.com", is_anonymous: false },
  });
  const encodedValid = "base64-" + Buffer.from(validPayload, "utf8").toString("base64url");
  const mid = Math.floor(encodedValid.length / 2);

  const staleAnonPayload = "base64-" + Buffer.from(
    JSON.stringify({ access_token: anonJwt, user: { id: "anon-1", is_anonymous: true } }),
    "utf8",
  ).toString("base64url");

  const picked = fm.selectBestFlowMusicSessionFromCookies([
    { name: "sb-sb-auth-token.0", value: staleAnonPayload, domain: "www.flowmusic.app", path: "/", storeId: "0" },
    { name: "sb-sb-auth-token.1", value: encodeURIComponent(encodedValid.slice(mid)), domain: ".flowmusic.app", path: "/", storeId: "0" },
    { name: "sb-sb-auth-token.0", value: encodeURIComponent(encodedValid.slice(0, mid)), domain: ".flowmusic.app", path: "/", storeId: "0" },
  ]);
  assert.ok(picked);
  assert.equal(picked.access_token, userJwt);
  assert.equal(picked.email, "valley@example.com");
  assert.equal("refresh_token" in picked, false);

  // 3. Quoted, standard base64 (+, /, =), and nested session object all decode cleanly
  const stdB64 = "base64-" + Buffer.from(
    JSON.stringify({ session: { access_token: userJwt, refresh_token: "NOPE", user: { user_metadata: { email: "meta@example.com" } } } }),
    "utf8",
  ).toString("base64");
  const nested = fm.extractSafeFlowMusicSession(`"${encodeURIComponent(stdB64)}"`);
  assert.ok(nested);
  assert.equal(nested.access_token, userJwt);
  assert.equal(nested.email, "meta@example.com");
  assert.equal("refresh_token" in nested, false);

  // 4. Passive webRequest sniffer captures authenticated Bearer JWT and ignores anon JWT
  const fmSniffer = webRequestListeners.find((l) =>
    l.filter?.urls?.some((u) => u.includes("flowmusic.app/__api")),
  );
  assert.ok(fmSniffer, "expected Flow Music webRequest Bearer listener");
  fmSniffer.fn({ requestHeaders: [{ name: "Authorization", value: `Bearer ${anonJwt}` }] });
  assert.equal(fm.getCaptured(), null);
  fmSniffer.fn({ requestHeaders: [{ name: "Authorization", value: `Bearer ${userJwt}` }] });
  assert.equal(fm.getCaptured()?.access_token, userJwt);
  assert.equal(fm.getCaptured()?.email, "valley@example.com");
});

