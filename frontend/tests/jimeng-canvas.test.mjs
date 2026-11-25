// Run from frontend: node --test tests/jimeng-canvas.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

test("nodeLabels normalises legacy English node titles, variant suffixes, and board names", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const { displayNodeTitle, displayBoardName } = await server.ssrLoadModule("/src/constants/nodeLabels.ts");

    assert.equal(displayNodeTitle("Character", "character"), "角色主体");
    assert.equal(displayNodeTitle("Visual asset", "visual_asset"), "物品素材");
    assert.equal(displayNodeTitle("Storyboard", "Storyboard"), "故事板");
    assert.equal(displayNodeTitle("Image (variant)", "image"), "图片（副本）");
    assert.equal(displayNodeTitle("自定义角色 (variant)", "character"), "自定义角色（副本）");
    assert.equal(displayNodeTitle(undefined, "prompt"), "文本");
    assert.equal(displayNodeTitle("   ", "note"), "便签");

    assert.equal(displayBoardName(undefined), "未命名项目");
    assert.equal(displayBoardName(""), "未命名项目");
    assert.equal(displayBoardName("Untitled"), "未命名项目");
    assert.equal(displayBoardName("秋季新品分镜"), "秋季新品分镜");
  } finally {
    await server.close();
  }
});

test("useReferencesStore supports primary tab switching, openPanel(tab), and filtering", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const { useReferencesStore, filterReferences } = await server.ssrLoadModule("/src/store/references.ts");

    useReferencesStore.setState({
      panelOpen: false,
      activeTab: "assets",
      items: [
        {
          id: 1,
          mediaId: "m-1",
          label: "韩系模特主播",
          kind: "character",
          aiBrief: "studio portrait",
          aspectRatio: "IMAGE_ASPECT_RATIO_SQUARE",
          tags: [],
          pinned: true,
          position: 0,
          sourceBoardId: 1,
          sourceNodeShortId: "C1",
          createdAt: "2026-11-22T10:00:00Z",
        },
        {
          id: 2,
          mediaId: "m-2",
          label: "奶油白T恤",
          kind: "visual_asset",
          aiBrief: "cream cropped tee",
          aspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT",
          tags: [],
          pinned: false,
          position: 1,
          sourceBoardId: 1,
          sourceNodeShortId: "V2",
          createdAt: "2026-11-22T10:05:00Z",
        },
      ],
    });

    useReferencesStore.getState().openPanel("boards");
    assert.equal(useReferencesStore.getState().panelOpen, true);
    assert.equal(useReferencesStore.getState().activeTab, "boards");

    useReferencesStore.getState().setActiveTab("subjects");
    assert.equal(useReferencesStore.getState().activeTab, "subjects");

    const byLabel = filterReferences(useReferencesStore.getState().items, "奶油");
    assert.equal(byLabel.length, 1);
    assert.equal(byLabel[0].mediaId, "m-2");

    const byBrief = filterReferences(useReferencesStore.getState().items, "portrait");
    assert.equal(byBrief.length, 1);
    assert.equal(byBrief[0].mediaId, "m-1");
  } finally {
    await server.close();
  }
});

test("useBoardStore hydrates renderedAt and aspectRatio across load, switch, and refresh", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  const savedFetch = globalThis.fetch;
  try {
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");

    const boardOne = { id: 1, name: "Untitled", created_at: "2026-11-22T09:00:00Z" };
    const boardTwo = { id: 2, name: "即梦测试画布", created_at: "2026-11-22T09:10:00Z" };

    const detailFor = (board) => ({
      board,
      nodes: [
        {
          id: 101,
          board_id: board.id,
          short_id: "N1",
          type: "visual_asset",
          x: 10,
          y: 20,
          w: 256,
          h: 192,
          status: "done",
          created_at: "2026-11-22T09:15:00Z",
          data: {
            title: "Visual asset",
            mediaId: "media-101",
            aspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT",
            renderedAt: "2026-11-22T09:16:00Z",
          },
        },
      ],
      edges: [],
    });

    globalThis.fetch = async (url) => {
      if (url === "/api/boards") return Response.json([boardOne, boardTwo]);
      if (url === "/api/boards/1") return Response.json(detailFor(boardOne));
      if (url === "/api/boards/2") return Response.json(detailFor(boardTwo));
      if (typeof url === "string" && url.includes("/requests")) return Response.json({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await useBoardStore.getState().loadInitialBoard();
    let node = useBoardStore.getState().nodes[0];
    assert.equal(node.data.title, "物品素材");
    assert.equal(node.data.aspectRatio, "IMAGE_ASPECT_RATIO_PORTRAIT");
    assert.equal(node.data.renderedAt, "2026-11-22T09:16:00Z");

    await useBoardStore.getState().switchBoard(2);
    node = useBoardStore.getState().nodes[0];
    assert.equal(useBoardStore.getState().boardName, "即梦测试画布");
    assert.equal(node.data.aspectRatio, "IMAGE_ASPECT_RATIO_PORTRAIT");
    assert.equal(node.data.renderedAt, "2026-11-22T09:16:00Z");

    await useBoardStore.getState().refreshBoardState();
    node = useBoardStore.getState().nodes[0];
    assert.equal(node.data.aspectRatio, "IMAGE_ASPECT_RATIO_PORTRAIT");
    assert.equal(node.data.renderedAt, "2026-11-22T09:16:00Z");
  } finally {
    globalThis.fetch = savedFetch;
    await server.close();
  }
});

test("findFreeCanvasPosition places consecutive and batch nodes without overlap", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const { collectOccupiedBoxes, findFreeCanvasPosition } = await server.ssrLoadModule("/src/lib/canvasLayout.ts");
    const placed = [];
    for (let i = 0; i < 4; i++) {
      const occupied = collectOccupiedBoxes([], placed, 256, 330);
      const pos = findFreeCanvasPosition({
        origin: { x: 100, y: 100 },
        occupied,
        width: 256,
        height: 330,
      });
      for (const box of placed) {
        const intersects = pos.x < box.x + box.width && pos.x + 256 > box.x
          && pos.y < box.y + box.height && pos.y + 330 > box.y;
        assert.equal(intersects, false);
      }
      placed.push({ x: pos.x, y: pos.y, width: 256, height: 330 });
    }
  } finally {
    await server.close();
  }
});

test("useDesktopFlowStore syncs inner browser state and localises desktop error hints", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  const savedWindow = globalThis.window;
  const savedFetch = globalThis.fetch;
  try {
    let pushedListener = null;
    let lastBounds = null;
    const initialState = {
      isEmbeddedRuntime: true,
      activeAccountId: "a".repeat(32),
      authState: "login_required",
      currentUrl: "https://flow.google.com/",
      projectIdDetected: null,
      paired: true,
      wsConnected: true,
      drawerOpen: true,
      drawerMode: "auto-onboarding",
      standaloneWindowOpen: false,
      lastError: null,
      notice: null,
    };

    globalThis.fetch = async () =>
      Response.json({
        active_account_id: "a".repeat(32),
        accounts: [],
        extension_path: "",
        embedded_browser: true,
      });

    globalThis.window = {
      flowboardDesktop: {
        getState: async () => initialState,
        onStateChange: (cb) => {
          pushedListener = cb;
          return () => {
            pushedListener = null;
          };
        },
        openDrawer: async (opts) => ({ ...initialState, drawerOpen: true, drawerMode: opts?.mode ?? "auto-onboarding" }),
        closeDrawer: async () => ({ ...initialState, drawerOpen: false }),
        setDrawerBounds: async (b) => {
          lastBounds = b;
        },
        reloadFlow: async () => {},
        openStandaloneAuthWindow: async () => {},
        syncAccountsNow: async () => initialState,
      },
    };

    const { useDesktopFlowStore } = await server.ssrLoadModule("/src/store/desktopFlow.ts");
    const { extractErrorMessage } = await server.ssrLoadModule("/src/api/client.ts");

    const cleanup = useDesktopFlowStore.getState().init();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(useDesktopFlowStore.getState().isDesktop, true);
    assert.equal(useDesktopFlowStore.getState().state?.authState, "login_required");

    pushedListener({
      ...initialState,
      authState: "authenticated",
      drawerOpen: false,
      projectIdDetected: "1dfd992a-4149-4f97-9d68-a1ede77d3fc3",
    });
    assert.equal(useDesktopFlowStore.getState().state?.authState, "authenticated");
    assert.equal(useDesktopFlowStore.getState().state?.drawerOpen, false);

    await useDesktopFlowStore.getState().closeDrawer();
    assert.equal(lastBounds?.visible, false);
    assert.equal(lastBounds?.x, -10000);

    const errMsg = await extractErrorMessage(
      new Response(JSON.stringify({ detail: "no_at_token" }), { status: 502 }),
    );
    assert.ok(errMsg.includes("内层 Flow 引擎"), `Expected desktop-aware message, got: ${errMsg}`);

    cleanup();
  } finally {
    globalThis.window = savedWindow;
    globalThis.fetch = savedFetch;
    await server.close();
  }
});

test("collectUpstreamRefEntries resolves Image -> Prompt -> Image chains and respects sourceVariantIdx", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const { collectUpstreamRefEntries, collectUpstreamRefMediaIds } = await server.ssrLoadModule("/src/store/generation.ts");
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");

    const nodes = [
      {
        id: "5",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          type: "image",
          shortId: "wuop",
          title: "图片",
          mediaId: "m-default",
          mediaIds: ["m-default", "m-var2"],
        },
      },
      {
        id: "6",
        type: "prompt",
        position: { x: 260, y: 0 },
        data: {
          type: "prompt",
          shortId: "s28m",
          title: "文本",
          prompt: "去掉字体生成三视图",
        },
      },
      {
        id: "7",
        type: "image",
        position: { x: 520, y: 0 },
        data: { type: "image", shortId: "0mgb", title: "目标图片" },
      },
    ];
    const edges = [
      { id: "e1", source: "5", target: "6", data: { sourceVariantIdx: 1 } },
      { id: "e2", source: "6", target: "7", data: { sourceVariantIdx: null } },
    ];

    const entries = collectUpstreamRefEntries("7", nodes, edges);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].node.id, "5");
    assert.equal(entries[0].mediaId, "m-var2");
    assert.equal(entries[0].variantIdx, 1);

    useBoardStore.setState({ nodes, edges });
    assert.deepEqual(collectUpstreamRefMediaIds("7"), ["m-var2"]);
  } finally {
    await server.close();
  }
});

test("collectUpstreamRefEntries resolves Video -> Video and Video -> Prompt -> Image chains plus upstream prompt text", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const {
      collectUpstreamRefEntries,
      collectUpstreamRefMediaIds,
      collectUpstreamPromptText,
    } = await server.ssrLoadModule("/src/store/generation.ts");
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");

    const nodes = [
      {
        id: "10",
        type: "video",
        position: { x: 0, y: 0 },
        data: {
          type: "video",
          shortId: "vd10",
          title: "视频",
          mediaId: "vid-ref-main.mp4",
          mediaIds: ["vid-ref-main.mp4", "vid-ref-alt.mp4"],
        },
      },
      {
        id: "11",
        type: "prompt",
        position: { x: 260, y: 0 },
        data: {
          type: "prompt",
          shortId: "pr11",
          title: "文本",
          prompt: "保持雨夜赛博霓虹氛围",
        },
      },
      {
        id: "12",
        type: "prompt",
        position: { x: 260, y: 180 },
        data: {
          type: "prompt",
          shortId: "pr12",
          title: "文本2",
          prompt: "镜头缓缓推进",
        },
      },
      {
        id: "13",
        type: "image",
        position: { x: 520, y: 0 },
        data: { type: "image", shortId: "im13", title: "延展图" },
      },
      {
        id: "14",
        type: "video",
        position: { x: 520, y: 220 },
        data: { type: "video", shortId: "vd14", title: "续接视频" },
      },
    ];
    const edges = [
      { id: "e10", source: "10", target: "11", data: { sourceVariantIdx: 1 } },
      { id: "e11", source: "11", target: "13", data: { sourceVariantIdx: null } },
      { id: "e12", source: "12", target: "13", data: { sourceVariantIdx: null } },
      { id: "e13", source: "10", target: "14", data: { sourceVariantIdx: null } },
    ];

    const imgEntries = collectUpstreamRefEntries("13", nodes, edges);
    assert.equal(imgEntries.length, 1);
    assert.equal(imgEntries[0].node.data.type, "video");
    assert.equal(imgEntries[0].mediaId, "vid-ref-alt.mp4");

    const vidEntries = collectUpstreamRefEntries("14", nodes, edges);
    assert.equal(vidEntries.length, 1);
    assert.equal(vidEntries[0].mediaId, "vid-ref-main.mp4");

    assert.equal(collectUpstreamPromptText("13", nodes, edges), "保持雨夜赛博霓虹氛围，镜头缓缓推进");
    assert.equal(collectUpstreamPromptText("14", nodes, edges), "");

    useBoardStore.setState({ nodes, edges });
    assert.deepEqual(collectUpstreamRefMediaIds("13"), ["vid-ref-alt.mp4"]);
    assert.deepEqual(collectUpstreamRefMediaIds("14"), ["vid-ref-main.mp4"]);
  } finally {
    await server.close();
  }
});

test("estimateImageCreditCost & estimateVideoCreditCost compute model/resolution/duration/tier credits", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const {
      VIDEO_RESOLUTION_OPTIONS,
      estimateImageCreditCost,
      estimateVideoCreditCost,
      estimateVideoUpscaleCreditCost,
    } = await server.ssrLoadModule("/src/constants/models.ts");

    assert.equal(VIDEO_RESOLUTION_OPTIONS.find((r) => r.value === "360p")?.omniOnly, true);

    // Veo 3.1 clamps 360p -> 720p
    const veo360Clamped = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "lite",
      videoResolution: "360p",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.ok(veo360Clamped.breakdown.includes("720p 原生"));
    assert.equal(veo360Clamped.total, 5);

    const img2k = estimateImageCreditCost({ imageModel: "NANO_BANANA_PRO", imageResolution: "2K", count: 2 });
    assert.equal(img2k.total, 0);
    assert.equal(img2k.isZero, true);
    assert.equal(img2k.displayText, "消耗 0 积分");
    assert.ok(img2k.breakdown.includes("2K"));

    const img4k = estimateImageCreditCost({ imageModel: "NANO_BANANA_PRO", imageResolution: "4K", count: 1 });
    assert.equal(img4k.total, 0);
    assert.equal(img4k.displayText, "消耗 0 积分");
    assert.ok(img4k.breakdown.includes("Ultra"));

    // Veo 3.1 Lite (8s) + 1080p: 1-10s upscale is 0 extra credits
    const veoLiteUltra1080 = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "lite",
      videoResolution: "1080p",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(veoLiteUltra1080.total, 5);
    assert.equal(veoLiteUltra1080.displayText, "消耗 5 积分");

    // Veo 3.1 Lite (8s) + 4K: 5 base + 50 4K upscale = 55 credits
    const veoLiteUltra4k = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "lite",
      videoResolution: "4k",
      count: 2,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(veoLiteUltra4k.perUnit, 55);
    assert.equal(veoLiteUltra4k.total, 110);

    const veoLitePro = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "lite",
      videoResolution: "720p",
      count: 1,
      paygateTier: "PAYGATE_TIER_ONE",
    });
    assert.equal(veoLitePro.total, 10);

    const veoLiteUnknown = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "lite",
      count: 1,
    });
    assert.equal(veoLiteUnknown.displayText, "消耗 5~10 积分");

    // Veo 3.1 Quality is 100 credits across ALL tiers (including Ultra)
    const veoQualityPro = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "quality",
      count: 2,
      paygateTier: "PAYGATE_TIER_ONE",
    });
    assert.equal(veoQualityPro.total, 200);
    const veoQualityUltra = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "quality",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(veoQualityUltra.total, 100);
    const veoQualityUnknown = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "quality",
      count: 1,
    });
    assert.equal(veoQualityUnknown.displayText, "消耗 100 积分");

    // Veo 3.1 Lite Relaxed (720p = 0 credits, 4K = +50 credits/clip!)
    const veoRelaxed = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "lite_relaxed",
      videoResolution: "720p",
      count: 4,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(veoRelaxed.total, 0);
    assert.equal(veoRelaxed.isZero, true);

    const veoRelaxed4k = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "lite_relaxed",
      videoResolution: "4k",
      count: 4,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(veoRelaxed4k.total, 200);
    assert.equal(veoRelaxed4k.isZero, false);
    assert.equal(veoRelaxed4k.displayText, "消耗 200 积分");

    // Omni 1.2 Flash 360p (1 credit/s up to 10s, +2 credits/s for 11-15s)
    const omni12_360_8s = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.2",
      durationSeconds: 8,
      videoResolution: "360p",
      count: 2,
      paygateTier: "PAYGATE_TIER_ONE",
    });
    assert.equal(omni12_360_8s.perUnit, 8);
    assert.equal(omni12_360_8s.total, 16);

    const omni12_360_15s = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.2",
      durationSeconds: 15,
      videoResolution: "360p",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(omni12_360_15s.total, 20);

    // Omni 1.2 Flash 720p (3 credits/s up to 10s, +6 credits/s for 11-15s)
    const omni12 = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.2",
      durationSeconds: 8,
      videoResolution: "720p",
      count: 2,
      paygateTier: "PAYGATE_TIER_ONE",
    });
    assert.equal(omni12.total, 48);

    const omni15s720 = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.2",
      durationSeconds: 15,
      videoResolution: "720p",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(omni15s720.total, 60);

    // Omni 1.2 Flash 15s + 1080p: 60 base + 5 (1 credit/s over 10s) = 65
    const omni15s1080 = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.2",
      durationSeconds: 15,
      videoResolution: "1080p",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(omni15s1080.total, 65);

    // Omni 1.2 Flash 15s + 4K: 60 base + 75 (50 + 5*5) = 135
    const omni15s4k = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.2",
      durationSeconds: 15,
      videoResolution: "4k",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(omni15s4k.total, 135);
    assert.equal(estimateVideoUpscaleCreditCost("1080p", 10), 0);
    assert.equal(estimateVideoUpscaleCreditCost("1080p", 12), 2);
    assert.equal(estimateVideoUpscaleCreditCost("4k", 8), 50);
    assert.equal(estimateVideoUpscaleCreditCost("4k", 15), 75);

    // Omni 1.1 Flash 720p vs 360p
    const omni11 = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.1",
      durationSeconds: 6,
      videoResolution: "720p",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(omni11.total, 20);
    const omni11_360 = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.1",
      durationSeconds: 6,
      videoResolution: "360p",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(omni11_360.total, 5);

    const { OMNI_1_2_DURATIONS } = await server.ssrLoadModule("/src/constants/models.ts");
    assert.equal(OMNI_1_2_DURATIONS[0], 3);
    assert.equal(OMNI_1_2_DURATIONS[OMNI_1_2_DURATIONS.length - 1], 15);
    assert.equal(OMNI_1_2_DURATIONS.length, 13);

    const omni3s = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.2",
      durationSeconds: 3,
      count: 1,
      paygateTier: "PAYGATE_TIER_ONE",
    });
    assert.equal(omni3s.total, 9);

    // Verify api() extracts FastAPI JSON detail on 409 instead of raw "409 Conflict"
    const { api, extractErrorMessage, humanizeBackendError } = await server.ssrLoadModule("/src/api/client.ts");
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ detail: "请先在 Flow 账号设置中绑定项目。" }), {
          status: 409,
          statusText: "Conflict",
          headers: { "Content-Type": "application/json" },
        });
      await assert.rejects(() => api("/api/boards/1/project", { method: "POST" }), {
        message: "请先在 Flow 账号设置中绑定项目。",
      });
    } finally {
      globalThis.fetch = origFetch;
    }

    // Verify SPrCad / PUBLIC_ERROR_UNUSUAL_ACTIVITY maps to actionable Chinese troubleshooting
    const sprcadRaw =
      "RpcError: SPrCad failed: [7, None, [['type.googleapis.com/google.rpc.ErrorInfo', ['PUBLIC_ERROR_UNUSUAL_ACTIVITY']]]]";
    const sprcadHuman = humanizeBackendError(sprcadRaw);
    assert.ok(sprcadHuman && sprcadHuman.includes("2K/4K"));
    assert.ok(sprcadHuman.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY"));
    assert.ok(sprcadHuman.includes("解决方法"));
    assert.ok(sprcadHuman.includes("flow.google.com"));
    assert.ok(sprcadHuman.includes("1K 标准"));

    const sprcadFromHttp = await extractErrorMessage(
      new Response(JSON.stringify({ detail: sprcadRaw }), {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "application/json" },
      }),
    );
    assert.equal(sprcadFromHttp, sprcadHuman);

    const genericUnusual = humanizeBackendError(
      "RpcError: L7aB1c failed: [7, None, [['type.googleapis.com/google.rpc.ErrorInfo', ['PUBLIC_ERROR_UNUSUAL_ACTIVITY']]]]",
    );
    assert.ok(genericUnusual && genericUnusual.includes("安全风控拦截") && genericUnusual.includes("解决方法"));

    const embeddedPublic = humanizeBackendError(
      "RpcError: SPrCad failed: [3, None, [['type.googleapis.com/google.rpc.ErrorInfo', ['PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED']]]]",
    );
    assert.ok(embeddedPublic && embeddedPublic.startsWith("Flow 内容或安全拦截："));

    const timeoutHuman = humanizeBackendError("timeout_waiting_video");
    assert.ok(timeoutHuman && timeoutHuman.includes("视频生成等待超时"));

    const as29sHuman = humanizeBackendError("as29s failed: [5]");
    assert.ok(as29sHuman && as29sHuman.includes("as29s [5]"));
  } finally {
    await server.close();
  }
});

test("subject templates support anime/3D/realistic/prop official templates and custom template CRUD", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const {
      OFFICIAL_SUBJECT_TEMPLATES,
      applySubjectTemplateText,
      useSubjectTemplatesStore,
    } = await server.ssrLoadModule("/src/constants/character.ts");

    assert.ok(OFFICIAL_SUBJECT_TEMPLATES.some((t) => t.id === "anime-extract" && t.category === "anime"));
    assert.ok(OFFICIAL_SUBJECT_TEMPLATES.some((t) => t.id === "anime-stand" && t.category === "anime"));
    assert.ok(OFFICIAL_SUBJECT_TEMPLATES.some((t) => t.id === "anime-turnaround" && t.category === "anime"));
    assert.ok(OFFICIAL_SUBJECT_TEMPLATES.some((t) => t.category === "3d_game"));
    assert.ok(OFFICIAL_SUBJECT_TEMPLATES.some((t) => t.category === "creature_prop"));

    const animeTpl = OFFICIAL_SUBJECT_TEMPLATES.find((t) => t.id === "anime-stand");
    const turnaroundTpl = OFFICIAL_SUBJECT_TEMPLATES.find((t) => t.id === "anime-turnaround");
    // Switching from one unmodified template directly to another replaces cleanly without stacking
    const firstApplied = applySubjectTemplateText("", animeTpl.prompt, null);
    assert.equal(firstApplied, animeTpl.prompt);
    const switched = applySubjectTemplateText(firstApplied, turnaroundTpl.prompt, animeTpl.prompt);
    assert.equal(switched, turnaroundTpl.prompt);

    // When user already typed custom anime traits, template merges without losing user text
    const merged = applySubjectTemplateText("银发红瞳小魔女，头戴黑色尖顶帽", animeTpl.prompt, null);
    assert.ok(merged.includes(animeTpl.prompt));
    assert.ok(merged.includes("银发红瞳小魔女，头戴黑色尖顶帽"));

    useSubjectTemplatesStore.setState({ customTemplates: [] });
    const created = useSubjectTemplatesStore.getState().addCustomTemplate(
      "赛博二次元女主",
      "日系赛博朋克二次元少女立绘，荧光蓝双马尾配机能风外套，纯黑干净背景",
    );
    assert.ok(created && created.id.startsWith("tpl_"));
    assert.equal(useSubjectTemplatesStore.getState().customTemplates.length, 1);

    const updated = useSubjectTemplatesStore.getState().updateCustomTemplate(
      created.id,
      "赛博二次元女主V2",
      "日系赛博朋克二次元少女三视图，荧光蓝双马尾，带战术护目镜",
    );
    assert.equal(updated, true);
    assert.equal(useSubjectTemplatesStore.getState().customTemplates[0].title, "赛博二次元女主V2");

    useSubjectTemplatesStore.getState().removeCustomTemplate(created.id);
    assert.equal(useSubjectTemplatesStore.getState().customTemplates.length, 0);
  } finally {
    await server.close();
  }
});

test("chatReferences syncs selected canvas nodes automatically, respects mute/pin, and merges #mentions", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const {
      resolveActiveCanvasReferences,
      mergeChatMentions,
      buildDefaultNodeChatMessage,
      resolveNodePrimaryMedia,
    } = await server.ssrLoadModule("/src/lib/chatReferences.ts");

    const nodes = [
      {
        id: "1",
        type: "character",
        selected: true,
        position: { x: 0, y: 0 },
        data: { type: "character", shortId: "wuop", title: "动漫角色", mediaId: "m-anime-1" },
      },
      {
        id: "2",
        type: "prompt",
        selected: false,
        position: { x: 260, y: 0 },
        data: { type: "prompt", shortId: "s28m", title: "文本", prompt: "去掉文字" },
      },
      {
        id: "3",
        type: "video",
        selected: false,
        position: { x: 520, y: 0 },
        data: { type: "video", shortId: "vd09", title: "视频", mediaIds: ["v-clip-1"] },
      },
    ];

    // Auto-includes selected node #wuop
    const autoRefs = resolveActiveCanvasReferences(nodes, new Set(), []);
    assert.equal(autoRefs.length, 1);
    assert.equal(autoRefs[0].node.data.shortId, "wuop");
    assert.equal(autoRefs[0].source, "selected");

    // Muting #wuop hides it, while pinning #vd09 includes #vd09
    const mutedAndPinned = resolveActiveCanvasReferences(nodes, new Set(["1"]), ["3"]);
    assert.equal(mutedAndPinned.length, 1);
    assert.equal(mutedAndPinned[0].node.data.shortId, "vd09");
    assert.equal(mutedAndPinned[0].source, "pinned");

    // Merging chip refs + inline #mentions deduplicates and drops unknown shortIds
    const mentions = mergeChatMentions("结合 #s28m 和 #wuop 以及不存在的 #zzzz 分析", autoRefs, nodes);
    assert.deepEqual(mentions, ["wuop", "s28m"]);

    const defaultMsg = buildDefaultNodeChatMessage("analyze", ["wuop"]);
    assert.ok(defaultMsg.includes("#wuop"));

    assert.deepEqual(resolveNodePrimaryMedia(nodes[0]), { mediaId: "m-anime-1", isVideo: false });
    assert.deepEqual(resolveNodePrimaryMedia(nodes[2]), { mediaId: "v-clip-1", isVideo: true });
    assert.equal(resolveNodePrimaryMedia(nodes[1]), null);
  } finally {
    await server.close();
  }
});

test("STARTER_RECIPES provides 3 complete Chinese workflows with valid node/edge graphs", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const { STARTER_RECIPES } = await server.ssrLoadModule("/src/constants/starterTemplates.ts");
    assert.equal(STARTER_RECIPES.length, 3);
    const seenIds = new Set();
    for (const recipe of STARTER_RECIPES) {
      assert.ok(recipe.id && !seenIds.has(recipe.id));
      seenIds.add(recipe.id);
      assert.ok(recipe.title.length > 0 && recipe.badge.length > 0 && recipe.boardName.length > 0);
      assert.ok(recipe.nodes.length >= 4);
      assert.ok(recipe.edges.length >= 2);
      const keys = new Set(recipe.nodes.map((n) => n.key));
      assert.equal(keys.size, recipe.nodes.length);
      for (const edge of recipe.edges) {
        assert.ok(keys.has(edge.source_key), `Missing source_key ${edge.source_key}`);
        assert.ok(keys.has(edge.target_key), `Missing target_key ${edge.target_key}`);
        assert.notEqual(edge.source_key, edge.target_key);
      }
    }
  } finally {
    await server.close();
  }
});

test("github release helper parses Setup/Portable assets, handles dismissal, and checks semver", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  const savedFetch = globalThis.fetch;
  try {
    const {
      CURRENT_APP_VERSION,
      dismissReleaseTag,
      getDismissedReleaseTag,
      getLatestRelease,
      isNewerVersion,
    } = await server.ssrLoadModule("/src/api/github.ts");

    assert.ok(/^\d+\.\d+\.\d+/.test(CURRENT_APP_VERSION));
    assert.equal(isNewerVersion("v0.9.1", "0.9"), true);
    assert.equal(isNewerVersion("v1.0", "0.9.0"), true);
    assert.equal(isNewerVersion("v0.9", "0.9.0"), false);
    assert.equal(isNewerVersion("v1.5.0", "1.4.0"), true);
    assert.equal(isNewerVersion("v1.4.1", "1.4.0"), true);
    assert.equal(isNewerVersion("v1.4.0", "1.4.0"), false);
    assert.equal(isNewerVersion("v1.10.0", "1.9.0"), true);

    globalThis.fetch = async () =>
      Response.json({
        tag_name: "v1.5.0",
        name: "AI Canvas Studio v1.5.0",
        body: "新增 .huabu 创作配方包导入导出与新手指引画布。",
        html_url: "https://github.com/Mon-Knight/AI-Canvas-Studio/releases/tag/v1.5.0",
        published_at: "2026-11-23T04:00:00Z",
        assets: [
          {
            name: "AI-Canvas-Studio-v1.5.0-win64-setup.exe",
            browser_download_url: "https://example.com/setup.exe",
          },
          {
            name: "AI-Canvas-Studio-v1.5.0-win64-portable.zip",
            browser_download_url: "https://example.com/portable.zip",
          },
        ],
      });

    const rel = await getLatestRelease(true);
    assert.ok(rel);
    assert.equal(rel.tagName, "v1.5.0");
    assert.equal(rel.setupUrl, "https://example.com/setup.exe");
    assert.equal(rel.portableUrl, "https://example.com/portable.zip");

    dismissReleaseTag("v1.5.0");
    if (typeof localStorage !== "undefined") {
      assert.equal(getDismissedReleaseTag(), "v1.5.0");
    }
  } finally {
    globalThis.fetch = savedFetch;
    await server.close();
  }
});

test("useBoardStore.applyStarterRecipe populates blank default board in place", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  const savedFetch = globalThis.fetch;
  try {
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");
    const populatedBoard = { id: 1, name: "示例·番剧角色锁脸与续拍", created_at: "2026-11-23T04:00:00Z" };
    let postedBody = null;

    useBoardStore.setState({
      boardId: 1,
      boardName: "未命名项目",
      boards: [{ id: 1, name: "未命名项目", created_at: "2026-11-23T04:00:00Z" }],
      nodes: [],
      edges: [],
    });

    globalThis.fetch = async (url, init) => {
      if (url === "/api/boards/import-recipe") {
        postedBody = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({ board: populatedBoard, nodes_count: 5, edges_count: 3, media_count: 0 });
      }
      if (url === "/api/boards") return Response.json([populatedBoard]);
      if (url === "/api/boards/1") {
        return Response.json({
          board: populatedBoard,
          nodes: [
            {
              id: 11,
              board_id: 1,
              short_id: "aa11",
              type: "character",
              x: 40,
              y: 210,
              w: 256,
              h: 196,
              status: "idle",
              created_at: "2026-11-23T04:00:00Z",
              data: { title: "主角三视图", prompt: "三视图" },
            },
          ],
          edges: [],
        });
      }
      if (typeof url === "string" && url.includes("/requests")) return Response.json({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const resBoard = await useBoardStore.getState().applyStarterRecipe("anime-series");
    assert.equal(postedBody.target_board_id, 1);
    assert.equal(resBoard?.id, 1);
    assert.equal(useBoardStore.getState().boardName, "示例·番剧角色锁脸与续拍");
    assert.equal(useBoardStore.getState().nodes.length, 1);
  } finally {
    globalThis.fetch = savedFetch;
    await server.close();
  }
});

test("Stage 1: 3x3 multicam storyboard, @ref mentions, video directives, and node history switching", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const {
      STORYBOARD_GRIDS,
      totalPanels,
      resolveStoryboardLayout,
      buildStoryboardPrompt,
    } = await server.ssrLoadModule("/src/lib/storyboardPrompt.ts");
    const {
      normalizePromptRefMentions,
      composeVideoPromptWithDirectives,
      VIDEO_CAMERA_PRESETS,
    } = await server.ssrLoadModule("/src/lib/promptMentions.ts");
    const { switchNodeHistoryVersion } = await server.ssrLoadModule("/src/lib/quickDerive.ts");
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");

    assert.ok(STORYBOARD_GRIDS.includes("3x3"));
    assert.equal(totalPanels("3x3"), 9);
    assert.deepEqual(resolveStoryboardLayout("3x3", "IMAGE_ASPECT_RATIO_PORTRAIT"), { rows: 3, cols: 3, total: 9 });

    const multiPrompt = buildStoryboardPrompt("咖啡馆女孩", "3x3", "IMAGE_ASPECT_RATIO_LANDSCAPE", "multicam");
    assert.ok(multiPrompt.includes("同场多机位"));
    assert.ok(multiPrompt.includes("3x3"));

    assert.equal(
      normalizePromptRefMentions("让 @图1 身穿 @图2 的外套在雨中回头，忽略 a@1.com 与 @99", 2),
      "让 ref_image_1 身穿 ref_image_2 的外套在雨中回头，忽略 a@1.com 与 @99",
    );
    assert.ok(VIDEO_CAMERA_PRESETS.length >= 6);
    const dirPrompt = composeVideoPromptWithDirectives({
      prompt: "慢步走向镜头",
      cameraKey: "dolly_in",
      dialogue: "今晚的雨好大",
      sfx: "雨水滴落声",
    });
    assert.ok(dirPrompt.includes("Slow Dolly In") && dirPrompt.includes("今晚的雨好大") && dirPrompt.includes("雨水滴落声"));

    useBoardStore.setState({
      boardId: null,
      nodes: [
        {
          id: "90",
          type: "image",
          position: { x: 0, y: 0 },
          data: {
            type: "image",
            shortId: "H90",
            title: "图片",
            mediaId: "m-v2",
            mediaIds: ["m-v2"],
            prompt: "v2 prompt",
            history: [
              { mediaId: "m-v1", mediaIds: ["m-v1"], prompt: "v1 prompt" },
              { mediaId: "m-v2", mediaIds: ["m-v2"], prompt: "v2 prompt" },
            ],
          },
        },
      ],
      edges: [],
    });
    switchNodeHistoryVersion("90", 0);
    assert.equal(useBoardStore.getState().nodes[0].data.mediaId, "m-v1");
    assert.equal(useBoardStore.getState().nodes[0].data.prompt, "v1 prompt");
  } finally {
    await server.close();
  }
});

test("Stage 2: director skills filter & canvas multi-select grouping", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  const savedFetch = globalThis.fetch;
  try {
    const { filterDirectorSkills, DIRECTOR_SKILLS } = await server.ssrLoadModule("/src/constants/directorSkills.ts");
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");

    assert.ok(DIRECTOR_SKILLS.length >= 5);
    assert.ok(filterDirectorSkills("剧本").some((s) => s.id === "script_breakdown"));
    assert.ok(filterDirectorSkills("拉片").some((s) => s.id === "video_remake"));

    globalThis.fetch = async () => Response.json({});
    useBoardStore.setState({
      boardId: 1,
      nodes: [
        { id: "1", type: "image", position: { x: 0, y: 0 }, data: { type: "image", shortId: "A1", title: "画面1" } },
        { id: "2", type: "video", position: { x: 300, y: 0 }, data: { type: "video", shortId: "V1", title: "视频1" } },
      ],
      edges: [],
    });

    const gid = await useBoardStore.getState().groupNodes(["1", "2"], "开场三镜");
    assert.ok(gid && gid.startsWith("grp_"));
    assert.equal(useBoardStore.getState().nodes[0].data.groupId, gid);
    assert.equal(useBoardStore.getState().nodes[1].data.groupTitle, "开场三镜");

    await useBoardStore.getState().ungroupNodes(["1", "2"]);
    assert.equal(useBoardStore.getState().nodes[0].data.groupId, undefined);
  } finally {
    globalThis.fetch = savedFetch;
    await server.close();
  }
});

test("Stage 3A: layerCanvasOps mask bounding-box, inpaint/erase prompts, outpaint layout & collage prompt", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const {
      computeMaskRegionSpec,
      composeInpaintPrompt,
      computeOutpaintPadLayout,
      composeOutpaintPrompt,
      composeCollageFusionPrompt,
    } = await server.ssrLoadModule("/src/lib/layerCanvasOps.ts");

    assert.equal(computeMaskRegionSpec([], 1000, 1000), null);

    const region = computeMaskRegionSpec(
      [[{ x: 150, y: 180, radius: 20 }, { x: 320, y: 310, radius: 20 }]],
      1000,
      1000,
    );
    assert.ok(region);
    assert.equal(region.quadrantLabel, "画面左上区域");
    assert.ok(region.percentDesc.includes("13%–34%"));

    const erasePrompt = composeInpaintPrompt("erase", region, "路人");
    assert.ok(erasePrompt.includes("ref_image_1") && erasePrompt.includes("消除"));

    const inpaintPrompt = composeInpaintPrompt("inpaint", region, "金色太阳镜");
    assert.ok(inpaintPrompt.includes("金色太阳镜") && inpaintPrompt.includes("局部重绘"));

    const padWide = computeOutpaintPadLayout(720, 1280, "16:9");
    assert.equal(padWide.canvasWidth, 1280);
    assert.equal(padWide.canvasHeight, 720);
    assert.equal(padWide.aspectRatio, "IMAGE_ASPECT_RATIO_LANDSCAPE");
    assert.ok(padWide.drawX > 0 && padWide.drawWidth < padWide.canvasWidth);

    const padExpand = computeOutpaintPadLayout(1280, 720, "expand_1_4x");
    assert.equal(padExpand.aspectRatio, "IMAGE_ASPECT_RATIO_LANDSCAPE");
    assert.ok(padExpand.drawWidth < padExpand.canvasWidth);

    const outPrompt = composeOutpaintPrompt(padWide, "延长室内木桌");
    assert.ok(outPrompt.includes("16:9") && outPrompt.includes("延长室内木桌"));

    const colPrompt = composeCollageFusionPrompt("统一暖金色黄昏侧光", ["女主角", "白咖啡杯"]);
    assert.ok(colPrompt.includes("女主角、白咖啡杯") && colPrompt.includes("黄昏侧光"));
  } finally {
    await server.close();
  }
});

test("Stage 3B: timelineAudio directives, shot ordering/exclusion & timelineExporter geometry", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const {
      composeAudioDirective,
      resolveOrderedTimelineShots,
      useTimelineAudioStore,
      VOICE_PRESETS,
      AMBIENCE_PRESETS,
    } = await server.ssrLoadModule("/src/store/timelineAudio.ts");
    const {
      computeContainRect,
      pickSupportedVideoRecorderMime,
    } = await server.ssrLoadModule("/src/lib/timelineExporter.ts");

    assert.ok(VOICE_PRESETS.length >= 5 && AMBIENCE_PRESETS.length >= 5);
    const dir = composeAudioDirective({
      voiceKey: "deep_cinema_male",
      dialogue: "今晚的雨还没停",
      sfx: "玻璃推门风铃声",
      ambienceKey: "city_rain_neon",
    });
    assert.ok(
      dir.includes("【声画指令】") &&
        dir.includes("电影深沉男声") &&
        dir.includes("今晚的雨还没停") &&
        dir.includes("玻璃推门风铃声"),
    );

    const store = useTimelineAudioStore.getState();
    store.resetTimelineOverrides();
    store.moveShotKey(["k1", "k2", "k3"], 2, -1); // -> [k1, k3, k2]
    store.toggleShotExcluded("k1");
    store.setShotImageDuration("k3", 5);

    const resolved = resolveOrderedTimelineShots(
      [{ key: "k1" }, { key: "k2" }, { key: "k3" }],
      useTimelineAudioStore.getState().customOrderKeys,
      useTimelineAudioStore.getState().shotOverrides,
      3,
    );
    assert.deepEqual(
      resolved.map((r) => [r.shot.key, r.excluded, r.imageDurationSec]),
      [
        ["k1", true, 3],
        ["k3", false, 5],
        ["k2", false, 3],
      ],
    );

    const fit = computeContainRect(720, 1280, 1280, 720, 1);
    assert.equal(fit.dh, 720);
    assert.equal(fit.dw, 405);
    assert.ok(fit.dx > 0 && fit.dy === 0);

    const mimeRes = pickSupportedVideoRecorderMime();
    assert.ok(mimeRes.ext === "webm" || mimeRes.ext === "mp4");
  } finally {
    await server.close();
  }
});

test("useBoardStore supports free node resizing, persistence hydration, and dimension reset", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  const savedFetch = globalThis.fetch;
  try {
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");

    const patches = [];
    let dbNodeData = {
      title: "角色主体",
      mediaId: "media-portrait-1",
      aspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT",
    };

    const board = { id: 9, name: "拉伸测试画布", created_at: "2026-11-23T12:00:00Z" };
    globalThis.fetch = async (url, init) => {
      if (url === "/api/boards") return Response.json([board]);
      if (url === "/api/boards/9") {
        return Response.json({
          board,
          nodes: [
            {
              id: 501,
              board_id: 9,
              short_id: "S1",
              type: "character",
              x: 100,
              y: 120,
              w: 240,
              h: 160,
              status: "done",
              created_at: "2026-11-23T12:01:00Z",
              data: { ...dbNodeData },
            },
          ],
          edges: [],
        });
      }
      if (url === "/api/nodes/501" && init?.method === "PATCH") {
        const body = JSON.parse(init.body);
        patches.push(body);
        if (body.data) {
          for (const [k, v] of Object.entries(body.data)) {
            if (v === null) delete dbNodeData[k];
            else dbNodeData[k] = v;
          }
        }
        return Response.json({
          id: 501,
          board_id: 9,
          short_id: "S1",
          type: "character",
          x: body.x ?? 100,
          y: body.y ?? 120,
          w: body.w ?? 240,
          h: body.h ?? 160,
          status: "done",
          created_at: "2026-11-23T12:01:00Z",
          data: { ...dbNodeData },
        });
      }
      if (typeof url === "string" && url.includes("/requests")) return Response.json({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await useBoardStore.getState().loadInitialBoard();
    let n = useBoardStore.getState().nodes[0];
    // Legacy SQLite default w=240/h=160 without customW/customH must NOT lock node width/height
    assert.equal(n.width, undefined);
    assert.equal(n.height, undefined);

    // Resize node freely
    await useBoardStore.getState().persistNodeDimensions("501", {
      x: 88.4,
      y: 95.8,
      width: 420.2,
      height: 540.7,
    });
    n = useBoardStore.getState().nodes[0];
    assert.equal(n.width, 420);
    assert.equal(n.height, 541);
    assert.deepEqual(n.position, { x: 88, y: 96 });
    assert.equal(n.data.customW, 420);
    assert.equal(n.data.customH, 541);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], {
      x: 88,
      y: 96,
      w: 420,
      h: 541,
      data: { customW: 420, customH: 541 },
    });

    // Refresh board from backend — custom dimensions must survive reload
    await useBoardStore.getState().refreshBoardState();
    n = useBoardStore.getState().nodes[0];
    assert.equal(n.width, 420);
    assert.equal(n.height, 541);
    assert.equal(n.style?.width, 420);
    assert.equal(n.style?.height, 541);

    // Reset dimensions — returns to natural intrinsic image sizing
    await useBoardStore.getState().resetNodeDimensions("501");
    n = useBoardStore.getState().nodes[0];
    assert.equal(n.width, undefined);
    assert.equal(n.height, undefined);
    assert.equal(n.style, undefined);
    assert.equal(n.data.customW, undefined);
    assert.equal(n.data.customH, undefined);
    assert.deepEqual(patches[1].data, { customW: null, customH: null });
  } finally {
    globalThis.fetch = savedFetch;
    await server.close();
  }
});

test("promptSafety client sanitizer, video confirm toggle, GIF89a/timecode helpers, and optional first-frame routing", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  const savedFetch = globalThis.fetch;
  try {
    const { sanitizePromptForFlowSafetyClient } = await server.ssrLoadModule("/src/lib/promptSafety.ts");
    const { formatVideoTimecode, encodeGif89a } = await server.ssrLoadModule("/src/lib/videoGifExport.ts");
    const { useSettingsStore } = await server.ssrLoadModule("/src/store/settings.ts");
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");
    const { useGenerationStore } = await server.ssrLoadModule("/src/store/generation.ts");
    const { useFlowAccounts } = await server.ssrLoadModule("/src/store/flowAccounts.ts");

    // 1. Prompt safety sanitizer
    const risky = sanitizePromptForFlowSafetyClient(
      "动漫少女毅然向后仰身纵入苍茫夜空，身体在失重气流中向深处坠落，大喊杀了你们",
    );
    assert.equal(risky.rewritten, true);
    assert.ok(risky.notes.length >= 2);
    assert.ok(!risky.text.includes("纵入苍茫夜空"));
    assert.ok(!risky.text.includes("杀了你们"));

    const safe = sanitizePromptForFlowSafetyClient("少女在樱花树下轻柔起舞，温暖夕阳逆光");
    assert.equal(safe.rewritten, false);
    assert.deepEqual(safe.notes, []);
    assert.equal(safe.text, "少女在樱花树下轻柔起舞，温暖夕阳逆光");

    // 2. Video generation confirmation preference (default "always", switchable to "never")
    assert.equal(useSettingsStore.getState().confirmBeforeVideoGen, "always");
    useSettingsStore.getState().setConfirmBeforeVideoGen("never");
    assert.equal(useSettingsStore.getState().confirmBeforeVideoGen, "never");
    useSettingsStore.getState().setConfirmBeforeVideoGen("always");
    assert.equal(useSettingsStore.getState().confirmBeforeVideoGen, "always");

    // 3. Video Showcase timecode + 270p GIF89a binary encoder
    assert.equal(formatVideoTimecode(0), "00:00:00");
    assert.equal(formatVideoTimecode(8), "00:08:00");
    assert.equal(formatVideoTimecode(65.5, 24), "01:05:12");

    const frame1 = new Uint8ClampedArray(4 * 4 * 4).fill(200);
    const frame2 = new Uint8ClampedArray(4 * 4 * 4).fill(80);
    const gif = encodeGif89a([frame1, frame2], 4, 4, 12);
    const header = String.fromCharCode(...gif.slice(0, 6));
    assert.equal(header, "GIF89a");
    assert.equal(gif[gif.length - 1], 0x3b);
    assert.ok(gif.length > 800);

    // 4. Optional first-frame videoSubMode routing: t2v vs ingredients vs first_frame vs first_last
    const posted = [];
    let reqCounter = 100;
    globalThis.fetch = async (url, options) => {
      if (url === "/api/requests" && options?.method === "POST") {
        posted.push(JSON.parse(options.body));
        return Response.json({ id: ++reqCounter, status: "done", result: { media_ids: [`v-${reqCounter}`] } });
      }
      if (typeof url === "string" && url.startsWith("/api/requests/")) {
        return Response.json({ id: reqCounter, status: "done", type: "gen_video", params: {}, result: { media_ids: [`v-${reqCounter}`] } });
      }
      return Response.json({});
    };

    const acc = {
      id: "acc-1",
      project_id: "proj-1",
      label: "主账号",
      credits: 500,
      connected: true,
      flow_tab_open: true,
      paygate_tier: "PAYGATE_TIER_TWO",
    };
    useFlowAccounts.getState().apply({ accounts: [acc], active_account_id: acc.id, extension_path: "" });
    useBoardStore.setState({
      boardId: 1,
      nodes: [
        { id: "1", type: "image", position: { x: 0, y: 0 }, data: { type: "image", shortId: "I1", title: "参考1", mediaId: "img-1", mediaIds: ["img-1"] } },
        { id: "2", type: "image", position: { x: 0, y: 200 }, data: { type: "image", shortId: "I2", title: "参考2", mediaId: "img-2", mediaIds: ["img-2"] } },
        { id: "3", type: "video", position: { x: 300, y: 0 }, data: { type: "video", shortId: "V3", title: "视频", status: "idle" } },
      ],
      edges: [
        { id: "e1", source: "1", target: "3", data: { sourceVariantIdx: null } },
        { id: "e2", source: "2", target: "3", data: { sourceVariantIdx: null } },
      ],
    });

    const resetVideoNode = () => {
      useGenerationStore.getState().cancelGeneration("3");
      useBoardStore.getState().updateNodeData("3", { status: "idle" });
    };

    // (a) Pure Text-to-Video ignores upstream images even when wired!
    await useGenerationStore.getState().dispatchGeneration("3", {
      kind: "video",
      prompt: "纯文本自由运镜海浪日出",
      videoSubMode: "t2v",
      flowAccountId: acc.id,
      flowProjectId: acc.project_id,
    });
    assert.equal(posted[0].type, "gen_video_text");
    assert.ok(!("start_media_id" in posted[0].params));
    resetVideoNode();

    // (b) Ingredients mode routes to gen_video_omni (ref_media_ids) without locking frame 0
    await useGenerationStore.getState().dispatchGeneration("3", {
      kind: "video",
      prompt: "让 @图1 穿着 @图2 的服装自由起舞",
      videoSubMode: "ingredients",
      videoModel: "veo",
      flowAccountId: acc.id,
      flowProjectId: acc.project_id,
    });
    assert.equal(posted[1].type, "gen_video_omni");
    assert.deepEqual(posted[1].params.ref_media_ids, ["img-1", "img-2"]);
    assert.ok(!("start_media_id" in posted[1].params));
    resetVideoNode();

    // (c) Explicit optional first_frame mode locks start_media_id via gen_video
    await useGenerationStore.getState().dispatchGeneration("3", {
      kind: "video",
      prompt: "首帧起拍微笑挥手",
      videoSubMode: "first_frame",
      sourceMediaId: "img-1",
      videoModel: "omni_flash",
      flowAccountId: acc.id,
      flowProjectId: acc.project_id,
    });
    assert.equal(posted[2].type, "gen_video");
    assert.equal(posted[2].params.start_media_id, "img-1");
    resetVideoNode();

    // (d) First + Last frame lock routes to gen_video_first_last
    await useGenerationStore.getState().dispatchGeneration("3", {
      kind: "video",
      prompt: "平滑过渡镜头",
      videoSubMode: "first_last",
      sourceMediaId: "img-1",
      endMediaId: "img-2",
      flowAccountId: acc.id,
      flowProjectId: acc.project_id,
    });
    assert.equal(posted[3].type, "gen_video_first_last");
    assert.equal(posted[3].params.start_media_id, "img-1");
    assert.equal(posted[3].params.end_media_id, "img-2");
    resetVideoNode();
  } finally {
    globalThis.fetch = savedFetch;
    await server.close();
  }
});

test("node double-click dropdown (openDialog) and settings-to-showcase (openViewer params/history) stay mutually exclusive", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");
    const { useGenerationStore } = await server.ssrLoadModule("/src/store/generation.ts");

    useBoardStore.setState({
      boardId: 1,
      nodes: [
        { id: "10", type: "image", selected: false, position: { x: 0, y: 0 }, data: { type: "image", shortId: "IM1", title: "图片" } },
        { id: "20", type: "video", selected: false, position: { x: 300, y: 0 }, data: { type: "video", shortId: "VD1", title: "视频" } },
      ],
      edges: [],
    });

    // Double-click opens anchored dropdown (openDialog) and highlights the node
    useGenerationStore.getState().openGenerationDialog("20", "慢镜头推近");
    assert.equal(useGenerationStore.getState().openDialog.rfId, "20");
    assert.equal(useGenerationStore.getState().openDialog.prompt, "慢镜头推近");
    assert.equal(useGenerationStore.getState().openViewer.rfId, null);
    assert.equal(useBoardStore.getState().nodes.find((n) => n.id === "20")?.selected, true);

    // Clicking Settings enters Showcase on "params" tab and closes the dropdown
    useGenerationStore.getState().openResultViewer("20", 0, "params");
    assert.equal(useGenerationStore.getState().openDialog.rfId, null);
    assert.equal(useGenerationStore.getState().openViewer.rfId, "20");
    assert.equal(useGenerationStore.getState().openViewer.tab, "params");

    // Clicking Preview / 展示页 opens Showcase on "history" tab
    useGenerationStore.getState().openResultViewer("10", 1, "history");
    assert.equal(useGenerationStore.getState().openViewer.rfId, "10");
    assert.equal(useGenerationStore.getState().openViewer.idx, 1);
    assert.equal(useGenerationStore.getState().openViewer.tab, "history");

    // Re-opening dropdown closes Showcase cleanly
    useGenerationStore.getState().openGenerationDialog("10", "晴朗海边");
    assert.equal(useGenerationStore.getState().openViewer.rfId, null);
    assert.equal(useGenerationStore.getState().openViewer.tab, "history");
    assert.equal(useGenerationStore.getState().openDialog.rfId, "10");
    assert.equal(useBoardStore.getState().nodes.find((n) => n.id === "10")?.selected, true);

    useGenerationStore.getState().closeGenerationDialog();
    assert.equal(useGenerationStore.getState().openDialog.rfId, null);
  } finally {
    await server.close();
  }
});

test("computeArrangedPositions computes stack, grid, row, column, align, and distribute layouts accurately", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const { computeArrangedPositions, computeRightSpawnPosition, resolveNodeBox } = await server.ssrLoadModule(
      "/src/lib/canvasArrange.ts",
    );

    // Fewer than 2 nodes produces empty map
    assert.equal(computeArrangedPositions([{ id: "1", x: 10, y: 20, width: 200, height: 150 }], "stack").size, 0);

    const boxes = [
      { id: "a", x: 400, y: 120, width: 200, height: 100 },
      { id: "b", x: 100, y: 80, width: 240, height: 160 },
      { id: "c", x: 760, y: 300, width: 200, height: 120 },
    ];

    // Stack: cascading deck starting at (minX=100, minY=80), ordered by y then x (b -> a -> c)
    const stacked = computeArrangedPositions(boxes, "stack");
    assert.deepEqual(stacked.get("b"), { x: 100, y: 80 });
    assert.deepEqual(stacked.get("a"), { x: 118, y: 94 });
    assert.deepEqual(stacked.get("c"), { x: 136, y: 108 });

    // Row: sorted by x (b -> a -> c), gap = 40
    const row = computeArrangedPositions(boxes, "row", 40);
    assert.deepEqual(row.get("b"), { x: 100, y: 80 });
    assert.deepEqual(row.get("a"), { x: 380, y: 80 });
    assert.deepEqual(row.get("c"), { x: 620, y: 80 });

    // Column: sorted by y (b -> a -> c), gap = 30
    const col = computeArrangedPositions(boxes, "column", 30);
    assert.deepEqual(col.get("b"), { x: 100, y: 80 });
    assert.deepEqual(col.get("a"), { x: 100, y: 270 });
    assert.deepEqual(col.get("c"), { x: 100, y: 400 });

    // Grid: 4 nodes arranged in 2x2 with per-column widths and per-row heights
    const four = [
      { id: "1", x: 50, y: 50, width: 200, height: 100 },
      { id: "2", x: 300, y: 60, width: 260, height: 140 },
      { id: "3", x: 60, y: 260, width: 220, height: 120 },
      { id: "4", x: 320, y: 270, width: 200, height: 120 },
    ];
    const grid = computeArrangedPositions(four, "grid", 40);
    assert.deepEqual(grid.get("1"), { x: 50, y: 50 });
    assert.deepEqual(grid.get("2"), { x: 310, y: 50 }); // col0 maxW=220 + gap 40 => 50+260=310
    assert.deepEqual(grid.get("3"), { x: 50, y: 230 }); // row0 maxH=140 + gap 40 => 50+180=230
    assert.deepEqual(grid.get("4"), { x: 310, y: 230 });

    // Alignments
    const left = computeArrangedPositions(boxes, "align_left");
    assert.equal(left.get("a")?.x, 100);
    assert.equal(left.get("c")?.x, 100);

    const right = computeArrangedPositions(boxes, "align_right");
    // maxRight = 760 + 200 = 960
    assert.equal(right.get("b")?.x, 960 - 240);
    assert.equal(right.get("a")?.x, 960 - 200);

    const centerX = computeArrangedPositions(boxes, "align_center_x");
    // centerX = (100 + 960) / 2 = 530
    assert.equal(centerX.get("b")?.x, 530 - 120);
    assert.equal(centerX.get("a")?.x, 530 - 100);

    const top = computeArrangedPositions(boxes, "align_top");
    assert.equal(top.get("c")?.y, 80);

    const bottom = computeArrangedPositions(boxes, "align_bottom");
    // maxBottom = 300 + 120 = 420
    assert.equal(bottom.get("a")?.y, 420 - 100);
    assert.equal(bottom.get("b")?.y, 420 - 160);

    const centerY = computeArrangedPositions(boxes, "align_center_y");
    // centerY = (80 + 420) / 2 = 250
    assert.equal(centerY.get("a")?.y, 250 - 50);

    // Distribute horizontally: span = 960 - 100 = 860, totalW = 640, spacing = 110
    const distH = computeArrangedPositions(boxes, "distribute_h", 20);
    assert.equal(distH.get("b")?.x, 100);
    assert.equal(distH.get("a")?.x, 100 + 240 + 110);
    assert.equal(distH.get("c")?.x, 100 + 240 + 110 + 200 + 110);

    // Distribute vertically: span = 420 - 80 = 340, totalH = 380 -> falls back to minimum gap 36
    const distV = computeArrangedPositions(boxes, "distribute_v", 36);
    assert.equal(distV.get("b")?.y, 80);
    assert.equal(distV.get("a")?.y, 80 + 160 + 36);
    assert.equal(distV.get("c")?.y, 80 + 160 + 36 + 100 + 36);

    // Spawn position to the right of selection bounding box
    const spawn = computeRightSpawnPosition(boxes, 76);
    assert.equal(spawn.x, 960 + 76);
    assert.equal(spawn.y, Math.round((80 + 420) / 2 - 110));

    // resolveNodeBox fallback sizing
    const fallbackBox = resolveNodeBox({
      id: "n9",
      type: "image",
      position: { x: 12, y: 34 },
      data: { type: "image", shortId: "N9", title: "图片" },
    });
    assert.deepEqual(fallbackBox, { id: "n9", x: 12, y: 34, width: 264, height: 210 });
  } finally {
    await server.close();
  }
});

test("collectSelectedMediaDownloads gathers unique multi-variant media files and skips text/empty nodes", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const { collectSelectedMediaDownloads } = await server.ssrLoadModule("/src/lib/canvasArrange.ts");

    const nodes = [
      {
        id: "1",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { type: "prompt", shortId: "P1", title: "文本", mediaId: "should-skip" },
      },
      {
        id: "2",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          type: "image",
          shortId: "I1",
          title: "赛博霓虹",
          mediaId: "m-img-1",
          mediaIds: ["m-img-1", null, "m-img-2"],
        },
      },
      {
        id: "3",
        type: "video",
        position: { x: 0, y: 0 },
        data: {
          type: "video",
          shortId: "V1",
          title: "推镜视频",
          mediaId: "m-vid-1",
          mediaIds: ["m-vid-1"],
        },
      },
      {
        id: "4",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          type: "image",
          shortId: "I2",
          title: "重复图",
          mediaId: "m-img-1",
        },
      },
      {
        id: "5",
        type: "image",
        position: { x: 0, y: 0 },
        data: { type: "image", shortId: "I3", title: "空节点" },
      },
    ];

    const downloads = collectSelectedMediaDownloads(nodes);
    assert.equal(downloads.length, 3);
    assert.equal(downloads[0].filename, "赛博霓虹-I1-1.png");
    assert.equal(downloads[0].mediaId, "m-img-1");
    assert.equal(downloads[1].filename, "赛博霓虹-I1-2.png");
    assert.equal(downloads[1].mediaId, "m-img-2");
    assert.equal(downloads[2].filename, "推镜视频-V1.mp4");
    assert.equal(downloads[2].mediaId, "m-vid-1");
  } finally {
    await server.close();
  }
});

test("useBoardStore.batchUpdateNodePositions updates multiple nodes atomically and persists PATCH requests", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  const savedFetch = globalThis.fetch;
  try {
    const { useBoardStore } = await server.ssrLoadModule("/src/store/board.ts");
    const patched = [];
    globalThis.fetch = async (url, init) => {
      if (typeof url === "string" && url.startsWith("/api/nodes/") && init?.method === "PATCH") {
        patched.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    useBoardStore.setState({
      boardId: 1,
      nodes: [
        { id: "101", type: "image", selected: true, position: { x: 10, y: 20 }, data: { type: "image", shortId: "A1", title: "图1" } },
        { id: "102", type: "image", selected: true, position: { x: 300, y: 40 }, data: { type: "image", shortId: "A2", title: "图2" } },
        { id: "103", type: "prompt", selected: false, position: { x: 600, y: 60 }, data: { type: "prompt", shortId: "T1", title: "文本" } },
      ],
      edges: [],
    });

    await useBoardStore.getState().batchUpdateNodePositions([
      { rfId: "101", x: 100, y: 100 },
      { rfId: "102", x: 400, y: 100 },
    ]);

    const after = useBoardStore.getState().nodes;
    assert.deepEqual(after.find((n) => n.id === "101")?.position, { x: 100, y: 100 });
    assert.deepEqual(after.find((n) => n.id === "102")?.position, { x: 400, y: 100 });
    assert.deepEqual(after.find((n) => n.id === "103")?.position, { x: 600, y: 60 });

    assert.equal(patched.length, 2);
    assert.deepEqual(patched[0], { url: "/api/nodes/101", body: { x: 100, y: 100 } });
    assert.deepEqual(patched[1], { url: "/api/nodes/102", body: { x: 400, y: 100 } });
  } finally {
    globalThis.fetch = savedFetch;
    await server.close();
  }
});

test("characterVoice resolves presets/custom traits and propagates fixed voice across character -> image -> prompt -> video", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const {
      resolveCharacterVoiceLabel,
      resolveCharacterVoiceDirective,
      collectUpstreamCharacterVoices,
    } = await server.ssrLoadModule("/src/constants/characterVoice.ts");
    const {
      SILENT_VIDEO_DIRECTIVE,
      composeVideoPromptWithDirectives,
    } = await server.ssrLoadModule("/src/lib/promptMentions.ts");

    assert.equal(resolveCharacterVoiceLabel("", ""), null);
    assert.equal(resolveCharacterVoiceLabel("bright_girl", ""), "清亮元气少女");
    assert.ok(resolveCharacterVoiceDirective("bright_girl", "略带南方口音").includes("略带南方口音"));
    assert.equal(resolveCharacterVoiceLabel("custom", "低沉沙哑摇滚女声"), "低沉沙哑摇滚女声");
    assert.equal(resolveCharacterVoiceDirective("custom", "低沉沙哑摇滚女声"), "低沉沙哑摇滚女声");

    const nodes = [
      {
        id: "1",
        type: "character",
        position: { x: 0, y: 0 },
        data: {
          type: "character",
          shortId: "CH1",
          title: "林浅",
          voicePreset: "warm_female",
          voiceCustom: "语尾略带笑意",
        },
      },
      {
        id: "2",
        type: "character",
        position: { x: 0, y: 240 },
        data: { type: "character", shortId: "CH2", title: "无音色路人" },
      },
      {
        id: "3",
        type: "image",
        position: { x: 300, y: 0 },
        data: { type: "image", shortId: "IM1", title: "雨夜街景" },
      },
      {
        id: "4",
        type: "prompt",
        position: { x: 600, y: 0 },
        data: { type: "prompt", shortId: "PR1", title: "分镜文本", prompt: "缓慢抬头微笑" },
      },
      {
        id: "5",
        type: "video",
        position: { x: 900, y: 0 },
        data: { type: "video", shortId: "VD1", title: "视频镜头" },
      },
    ];
    const edges = [
      { id: "e1", source: "1", target: "3" },
      { id: "e2", source: "2", target: "3" },
      { id: "e3", source: "3", target: "4" },
      { id: "e4", source: "4", target: "5" },
      // Diamond duplicate edge back from character 1 directly to video 5
      { id: "e5", source: "1", target: "5" },
    ];

    const voices = collectUpstreamCharacterVoices("5", nodes, edges);
    assert.equal(voices.length, 1);
    assert.equal(voices[0].rfId, "1");
    assert.equal(voices[0].title, "林浅");
    assert.equal(voices[0].label, "温柔治愈女声");
    assert.ok(voices[0].directive.includes("语尾略带笑意"));

    // Non-silent with explicit dialogue pairs character voice with dialogue
    const voicedWithDlg = composeVideoPromptWithDirectives({
      prompt: "林浅撑伞走在雨夜街头",
      cameraKey: "dolly_in",
      dialogue: "今晚的雨下得好温柔",
      sfx: "细雨打伞声",
      silentVideo: false,
      characterVoices: voices,
    });
    assert.ok(voicedWithDlg.includes("严格保持绑定固定音色"));
    assert.ok(voicedWithDlg.includes("林浅"));
    assert.ok(voicedWithDlg.includes("今晚的雨下得好温柔"));
    assert.ok(voicedWithDlg.includes("细雨打伞声"));

    // Non-silent without explicit dialogue still embeds conditional voice binding
    const voicedNoDlg = composeVideoPromptWithDirectives({
      prompt: "林浅回眸轻声说话",
      cameraKey: "dynamic",
      silentVideo: false,
      characterVoices: voices,
    });
    assert.ok(voicedNoDlg.includes("角色固定音色绑定"));
    assert.ok(voicedNoDlg.includes("林浅"));

    // Silent Video overrides dialogue, SFX, character voices, AND strips 【声画指令】
    const silentOut = composeVideoPromptWithDirectives({
      prompt: "林浅站在窗边凝望远方\n【声画指令】角色台词：“你好”；环境氛围音：钢琴",
      cameraKey: "static",
      dialogue: "这段台词应被静音开关屏蔽",
      sfx: "这段音效也应被屏蔽",
      silentVideo: true,
      characterVoices: voices,
    });
    assert.ok(silentOut.includes(SILENT_VIDEO_DIRECTIVE));
    assert.ok(!silentOut.includes("【声画指令】"));
    assert.ok(!silentOut.includes("这段台词应被静音开关屏蔽"));
    assert.ok(!silentOut.includes("这段音效也应被屏蔽"));
    assert.ok(!silentOut.includes("林浅（"));
  } finally {
    await server.close();
  }
});

test("computeSmartSnapGuides magnetically snaps heterogeneous modules and emits clean gap-spanning dashed guides", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, logLevel: "error" });
  try {
    const {
      computeSmartSnapGuides,
      resolveSnapRect,
      DEFAULT_NODE_HEADER_OFFSET,
    } = await server.ssrLoadModule("/src/lib/smartSnapGuides.ts");

    const leftImage = resolveSnapRect(
      {
        id: "img-2",
        type: "image",
        position: { x: 100, y: 120 },
        data: { type: "image", shortId: "IM2", title: "图片 2" },
      },
      { width: 256, height: 241 },
    );
    assert.equal(leftImage.surfaceTopOffset, DEFAULT_NODE_HEADER_OFFSET);

    // Dragging a same-height video/audio module to the right within 4px of horizontal alignment
    const draggedRight = resolveSnapRect(
      {
        id: "vid-1",
        type: "video",
        position: { x: 520, y: 124 },
        data: { type: "video", shortId: "VD1", title: "视频 1" },
      },
      { width: 256, height: 241 },
    );

    const hSnap = computeSmartSnapGuides(draggedRight, [leftImage], 7);
    assert.equal(hSnap.didSnapY, true);
    assert.equal(hSnap.snappedY, 120);
    assert.equal(hSnap.didSnapX, false);

    // Expect ALL THREE horizontal dashed lines (surface top, centerY, bottom) spanning strictly across the gap [356, 520]
    const hGuides = hSnap.guides.filter((g) => g.orientation === "h");
    assert.equal(hGuides.length, 3);
    const ys = hGuides.map((g) => g.pos).sort((a, b) => a - b);
    assert.deepEqual(ys, [120 + 31, (120 + 31 + 120 + 241) / 2, 120 + 241]);
    for (const g of hGuides) {
      assert.equal(g.start, 100 + 256);
      assert.equal(g.end, 520);
    }

    // Dragging a shorter prompt module aligned to vertical center of leftImage
    const draggedPrompt = resolveSnapRect(
      {
        id: "pr-1",
        type: "prompt",
        position: { x: 520, y: 175 }, // surface top=206, bottom=295, center=250.5 vs leftImage center=256
        data: { type: "prompt", shortId: "PR1", title: "文本" },
      },
      { width: 256, height: 120 },
    );
    const centerSnap = computeSmartSnapGuides(draggedPrompt, [leftImage], 8);
    assert.equal(centerSnap.didSnapY, true);
    const centerGuides = centerSnap.guides.filter((g) => g.orientation === "h");
    assert.equal(centerGuides.length, 1);
    assert.equal(centerGuides[0].kind, "center");
    assert.equal(centerGuides[0].pos, 256);

    // Dragging a module below leftImage within X snap threshold yields vertical left/center/right lines
    const draggedBelow = resolveSnapRect(
      {
        id: "char-1",
        type: "character",
        position: { x: 105, y: 440 },
        data: { type: "character", shortId: "CH1", title: "角色" },
      },
      { width: 256, height: 220 },
    );
    const vSnap = computeSmartSnapGuides(draggedBelow, [leftImage], 7);
    assert.equal(vSnap.didSnapX, true);
    assert.equal(vSnap.snappedX, 100);
    const vGuides = vSnap.guides.filter((g) => g.orientation === "v");
    assert.equal(vGuides.length, 3);
    assert.deepEqual(
      vGuides.map((g) => g.pos).sort((a, b) => a - b),
      [100, 228, 356],
    );
    for (const g of vGuides) {
      assert.equal(g.start, 120 + 241);
      assert.equal(g.end, 440);
    }

    // Far away -> no snap & no guides
    const farAway = computeSmartSnapGuides(
      { ...draggedRight, x: 900, y: 900 },
      [leftImage],
      7,
    );
    assert.equal(farAway.didSnapX, false);
    assert.equal(farAway.didSnapY, false);
    assert.equal(farAway.guides.length, 0);
  } finally {
    await server.close();
  }
});



