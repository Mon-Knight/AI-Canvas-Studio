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
    } = await server.ssrLoadModule("/src/constants/models.ts");

    assert.equal(VIDEO_RESOLUTION_OPTIONS.find((r) => r.value === "360p")?.omniOnly, true);

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

    const veoLiteUltra = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "lite",
      videoResolution: "1080p",
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(veoLiteUltra.total, 5);
    assert.equal(veoLiteUltra.displayText, "消耗 5 积分");

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

    const veoQualityPro = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "quality",
      count: 2,
      paygateTier: "PAYGATE_TIER_ONE",
    });
    assert.equal(veoQualityPro.total, 200);

    const veoRelaxed = estimateVideoCreditCost({
      videoModel: "veo",
      videoQuality: "lite_relaxed",
      count: 4,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(veoRelaxed.total, 0);
    assert.equal(veoRelaxed.isZero, true);

    const omni12 = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.2",
      durationSeconds: 8,
      count: 2,
      paygateTier: "PAYGATE_TIER_ONE",
    });
    assert.equal(omni12.total, 48);

    const omni11 = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.1",
      durationSeconds: 6,
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(omni11.total, 20);

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

    const omni15s = estimateVideoCreditCost({
      videoModel: "omni_flash",
      omniVersion: "1.2",
      durationSeconds: 15,
      count: 1,
      paygateTier: "PAYGATE_TIER_TWO",
    });
    assert.equal(omni15s.total, 45);
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
