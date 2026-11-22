// Run from frontend: node --test tests/flow-video.test.mjs
// Render requests are intercepted locally. No browser profile or provider key is used.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

test("selecting a draft is free; submission is bound to the visible account and project", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, logLevel: "error" });
  const savedFetch = globalThis.fetch;
  let gen;
  try {
    const { useBoardStore: board } = await server.ssrLoadModule("/src/store/board.ts");
    const { useGenerationStore } = await server.ssrLoadModule("/src/store/generation.ts");
    gen = useGenerationStore;
    const { useFlowAccounts: accounts } = await server.ssrLoadModule("/src/store/flowAccounts.ts");
    const { useSettingsStore: settings } = await server.ssrLoadModule("/src/store/settings.ts");
    const received = [];
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    let pollCount = 0;
    globalThis.fetch = async (url, options) => {
      if (url === "/api/requests/10") {
        return Response.json({id: 10, status: ++pollCount === 1 ? "running" : "done", type: "gen_video",
          params: {media_provider: "flow", video_quality: "fast"}, result: {media_ids: ["new-take"]}});
      }
      if (url === "/api/nodes/7" && options.method === "PATCH") return Response.json({});
      assert.equal(url, "/api/requests");
      assert.equal(options.method, "POST");
      received.push(JSON.parse(options.body));
      await gate;
      return Response.json({ id: 10, status: "queued" });
    };
    const account = (id, project_id) => ({
      id, project_id, label: id, credits: 0, connected: true, flow_tab_open: true, paygate_tier: null,
    });
    const a = account("alpha", "first"), b = account("beta", "second");
    const select = row => accounts.getState().apply({accounts: [a, b], active_account_id: row?.id ?? null, extension_path: ""});
    board.setState({
      boardId: 1,
      nodes: [{ id: "7", type: "video", position: {x: 0, y: 0}, data: {
        type: "video", title: "分镜", shortId: "V7", status: "done", mediaId: "old", mediaIds: ["old"],
      }}], edges: [],
    });
    settings.setState({ mediaProvider: "muse", videoModel: "veo" });
    gen.getState().openGenerationDialog("7", "慢速推镜");
    assert.equal(board.getState().nodes[0].selected, true);
    assert.equal(gen.getState().openDialog.rfId, null);
    assert.equal(gen.getState().videoDraft.prompt, "慢速推镜");
    const opts = { kind: "video", prompt: "慢速推镜", sourceMediaId: "frame", flowAccountId: a.id, flowProjectId: a.project_id };
    select(null);
    await gen.getState().dispatchGeneration("7", opts);
    select(b);
    await gen.getState().dispatchGeneration("7", opts);
    select(a);
    await gen.getState().dispatchGeneration("7", { ...opts, flowProjectId: "stale" });
    assert.equal(received.length, 0);
    const first = gen.getState().dispatchGeneration("7", opts);
    await gen.getState().dispatchGeneration("7", opts);
    finish();
    await first;
    assert.equal(received.length, 1);
    const [job] = received;
    assert.deepEqual([job.flow_account_id, job.params.project_id, job.params.media_provider, job.params.start_media_id],
      [a.id, a.project_id, "flow", "frame"]);
    assert.ok(!("paygate_tier" in job.params));
    assert.equal(gen.getState().videoDraft, null);
    assert.equal(board.getState().nodes[0].data.status, "queued");
    assert.equal(board.getState().nodes[0].data.mediaId, "old");
    assert.equal(accounts.getState().snapshot.accounts[0].credits, 0);
    const waitFor = async (matches) => {
      for (let i = 0; i < 100; i++) {
        if (matches()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail("Timed out waiting for the task state");
    };
    await waitFor(() => board.getState().nodes[0].data.status === "running");
    await waitFor(() => board.getState().nodes[0].data.status === "done");
    assert.equal(board.getState().nodes[0].data.mediaId, "new-take");
    assert.equal(received.length, 1);
    assert.equal(accounts.getState().snapshot.accounts[0].credits, 0);
  } finally {
    gen?.getState().cancelGeneration("7");
    globalThis.fetch = savedFetch;
    await server.close();
  }
});
