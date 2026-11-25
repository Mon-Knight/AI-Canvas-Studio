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
