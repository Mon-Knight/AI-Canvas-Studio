/**
 * 左栏「❖ 图层编辑」& 节点快捷栏唤起的精修画板（即梦深空毛玻璃居中工作舱）：
 * - Tab 1: 🖌️ 局部重绘 / 一键消除笔（画笔涂抹蒙版 -> Flow maseQ 上传引导图 + 0 积分 edit_image 原图底座精修）
 * - Tab 2: ↔️ 比例扩图（16:9 / 9:16 / 1:1 / 四周扩展 1.4x 边缘柔化底板 + Flow 0 积分无缝扩图）
 * - Tab 3: 🧩 多节点拼贴融合（跨节点素材自由拖拽排版/缩放/镜像 -> 扁平化合成图 + Flow 0 积分光影统一重绘）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEdge, createNode, mediaUrl, patchNode, uploadImage } from "../api/client";
import { displayNodeTitle } from "../constants/nodeLabels";
import { collectOccupiedBoxes, findFreeCanvasPosition } from "../lib/canvasLayout";
import { pickImageFiles } from "../lib/filePicker";
import {
  composeCollageFusionPrompt,
  composeInpaintPrompt,
  composeOutpaintPrompt,
  computeMaskRegionSpec,
  computeOutpaintPadLayout,
  type CollageLayerItem,
  type MaskPoint,
  type OutpaintPresetKey,
} from "../lib/layerCanvasOps";
import { useBoardStore, type FlowNode } from "../store/board";
import { useGenerationStore } from "../store/generation";

export type LayerEditorTab = "inpaint" | "outpaint" | "collage";

interface OpenLayerEditorDetail {
  rfId?: string;
  tab?: LayerEditorTab;
}

const IMAGE_SOURCE_TYPES = new Set(["image", "character", "visual_asset", "Storyboard"]);

const OUTPAINT_PRESETS: Array<{ key: OutpaintPresetKey; label: string }> = [
  { key: "16:9", label: "16:9 横屏扩图" },
  { key: "9:16", label: "9:16 竖屏扩图" },
  { key: "1:1", label: "1:1 方图扩图" },
  { key: "expand_1_4x", label: "四周扩展 1.4x" },
];

const COLLAGE_CANVAS_PRESETS = [
  { key: "16:9" as const, label: "16:9 横屏", width: 1280, height: 720, enumVal: "IMAGE_ASPECT_RATIO_LANDSCAPE" },
  { key: "9:16" as const, label: "9:16 竖屏", width: 720, height: 1280, enumVal: "IMAGE_ASPECT_RATIO_PORTRAIT" },
  { key: "1:1" as const, label: "1:1 方图", width: 1024, height: 1024, enumVal: "IMAGE_ASPECT_RATIO_SQUARE" },
];

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("加载参考图片失败，请确认图片已就绪"));
    img.src = src;
  });
}

function canvasToPngFile(canvas: HTMLCanvasElement, filename: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("画布导出 PNG 失败"));
          return;
        }
        resolve(new File([blob], filename, { type: "image/png" }));
      },
      "image/png",
      0.95,
    );
  });
}

async function createSeededDownstreamImageNode(opts: {
  sourceNodes: FlowNode[];
  title: string;
  prompt: string;
  seedMediaId: string;
  aspectRatio?: string;
}): Promise<string> {
  const state = useBoardStore.getState();
  const boardId = state.boardId;
  if (boardId === null || opts.sourceNodes.length === 0) {
    throw new Error("当前没有可用的画布上下文");
  }
  const anchor = opts.sourceNodes[0];
  const occupied = collectOccupiedBoxes(state.nodes, [], 256, 320);
  const pos = findFreeCanvasPosition({
    origin: { x: anchor.position.x + 330, y: anchor.position.y },
    occupied,
    width: 256,
    height: 320,
  });
  const nowIso = new Date().toISOString();

  const dto = await createNode({
    board_id: boardId,
    type: "image",
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    data: {
      title: opts.title,
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
    },
  });

  await patchNode(dto.id, {
    status: "done",
    data: {
      mediaId: opts.seedMediaId,
      mediaIds: [opts.seedMediaId],
      renderedAt: nowIso,
      ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
    },
  });

  const createdEdges: ReturnType<typeof useBoardStore.getState>["edges"] = [];
  const seenSrcIds = new Set<string>();
  for (const src of opts.sourceNodes) {
    if (seenSrcIds.has(src.id)) continue;
    seenSrcIds.add(src.id);
    const srcDbId = parseInt(src.id, 10);
    if (isNaN(srcDbId)) continue;
    try {
      const eDto = await createEdge({
        board_id: boardId,
        source_id: srcDbId,
        target_id: dto.id,
      });
      createdEdges.push({
        id: String(eDto.id),
        source: String(eDto.source_id),
        target: String(eDto.target_id),
        data: { sourceVariantIdx: null },
      });
    } catch {
      // non-fatal if edge creation fails
    }
  }

  const newRfNode: FlowNode = {
    id: String(dto.id),
    type: "image",
    position: { x: dto.x, y: dto.y },
    data: {
      type: "image",
      shortId: dto.short_id,
      title: opts.title,
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
      mediaId: opts.seedMediaId,
      mediaIds: [opts.seedMediaId],
      renderedAt: nowIso,
      status: "done",
    },
  };

  useBoardStore.setState((s) => ({
    nodes: [
      ...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
      { ...newRfNode, selected: true },
    ],
    edges: [...s.edges, ...createdEdges],
  }));

  return newRfNode.id;
}

export function LayerEditorModal() {
  const nodes = useBoardStore((s) => s.nodes);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<LayerEditorTab>("inpaint");
  const [sourceRfId, setSourceRfId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tab 1: Inpaint / Erase state
  const [inpaintSubMode, setInpaintSubMode] = useState<"inpaint" | "erase">("inpaint");
  const [inpaintTargetMode, setInpaintTargetMode] = useState<"child" | "inplace">("child");
  const [brushSize, setBrushSize] = useState(34);
  const [inpaintPrompt, setInpaintPrompt] = useState("");
  const [strokes, setStrokes] = useState<MaskPoint[][]>([]);
  const inpaintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const inpaintImgRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef(false);
  const [inpaintCanvasSize, setInpaintCanvasSize] = useState<{ w: number; h: number }>({ w: 960, h: 540 });

  // Tab 2: Outpaint state
  const [outpaintPreset, setOutpaintPreset] = useState<OutpaintPresetKey>("16:9");
  const [outpaintHint, setOutpaintHint] = useState("");
  const outpaintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [outpaintImgDims, setOutpaintImgDims] = useState<{ w: number; h: number }>({ w: 1024, h: 1024 });

  // Tab 3: Collage state
  const [collageAspectKey, setCollageAspectKey] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [collageLayers, setCollageLayers] = useState<CollageLayerItem[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [collagePrompt, setCollagePrompt] = useState("");
  const collageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const collageImgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const dragLayerRef = useRef<{ layerId: string; offsetX: number; offsetY: number } | null>(null);

  const imageNodes = useMemo(
    () =>
      nodes.filter(
        (n) =>
          IMAGE_SOURCE_TYPES.has(n.data.type) &&
          typeof n.data.mediaId === "string" &&
          n.data.mediaId.length > 0,
      ),
    [nodes],
  );

  const sourceNode = useMemo(
    () => imageNodes.find((n) => n.id === sourceRfId) ?? imageNodes[0] ?? null,
    [imageNodes, sourceRfId],
  );

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<OpenLayerEditorDetail | undefined>).detail;
      const curNodes = useBoardStore.getState().nodes;
      const validImages = curNodes.filter(
        (n) =>
          IMAGE_SOURCE_TYPES.has(n.data.type) &&
          typeof n.data.mediaId === "string" &&
          n.data.mediaId.length > 0,
      );
      const picked =
        (detail?.rfId && validImages.find((n) => n.id === detail.rfId)) ||
        validImages.find((n) => n.selected) ||
        validImages[0] ||
        null;

      setSourceRfId(picked?.id ?? "");
      setTab(detail?.tab ?? "inpaint");
      setStrokes([]);
      setInpaintPrompt("");
      setOutpaintHint("");
      setError(null);
      if (picked?.data.mediaId) {
        setCollageLayers([
          {
            id: `layer_${Date.now().toString(36)}`,
            rfId: picked.id,
            mediaId: picked.data.mediaId,
            title: displayNodeTitle(picked.data.title, picked.data.type),
            x: 0.5,
            y: 0.52,
            scale: 0.62,
            flipX: false,
          },
        ]);
      } else {
        setCollageLayers([]);
      }
      setSelectedLayerId(null);
      setOpen(true);
    };
    window.addEventListener("flowboard:open-layer-editor", onOpen);
    return () => window.removeEventListener("flowboard:open-layer-editor", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy]);

  // ── Draw Tab 1 (Inpaint / Erase) canvas ────────────────────────────────────
  const drawInpaintCanvas = useCallback(
    (strokeList: MaskPoint[][]) => {
      const canvas = inpaintCanvasRef.current;
      const img = inpaintImgRef.current;
      if (!canvas || !img) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const stroke of strokeList) {
        if (stroke.length === 0) continue;
        if (stroke.length === 1) {
          const p = stroke[0];
          ctx.fillStyle = "rgba(56, 189, 248, 0.45)";
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.strokeStyle = "rgba(56, 189, 248, 0.45)";
        ctx.lineWidth = Math.max(4, stroke[0].radius * 2);
        ctx.beginPath();
        ctx.moveTo(stroke[0].x, stroke[0].y);
        for (let i = 1; i < stroke.length; i += 1) {
          ctx.lineTo(stroke[i].x, stroke[i].y);
        }
        ctx.stroke();
      }
      ctx.restore();
    },
    [],
  );

  useEffect(() => {
    if (!open || !sourceNode?.data.mediaId) {
      inpaintImgRef.current = null;
      return;
    }
    let canceled = false;
    void loadImageElement(mediaUrl(sourceNode.data.mediaId))
      .then((img) => {
        if (canceled) return;
        inpaintImgRef.current = img;
        const maxSide = 1120;
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const w = Math.max(64, Math.round((img.naturalWidth || 960) * scale));
        const h = Math.max(64, Math.round((img.naturalHeight || 540) * scale));
        setInpaintCanvasSize({ w, h });
        setOutpaintImgDims({
          w: img.naturalWidth || 1024,
          h: img.naturalHeight || 1024,
        });
        setStrokes([]);
        requestAnimationFrame(() => drawInpaintCanvas([]));
      })
      .catch((err) => {
        if (!canceled) {
          setError(err instanceof Error ? err.message : "加载图片失败");
        }
      });
    return () => {
      canceled = true;
    };
  }, [open, sourceNode?.id, sourceNode?.data.mediaId, drawInpaintCanvas]);

  useEffect(() => {
    if (!open || tab !== "inpaint") return;
    drawInpaintCanvas(strokes);
  }, [open, tab, strokes, inpaintCanvasSize, drawInpaintCanvas]);

  const toCanvasPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>): MaskPoint => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
      radius: Math.max(6, (brushSize / 2) * scaleX),
    };
  }, [brushSize]);

  // ── Draw Tab 2 (Outpaint) live preview ─────────────────────────────────────
  const outpaintLayout = useMemo(
    () => computeOutpaintPadLayout(outpaintImgDims.w, outpaintImgDims.h, outpaintPreset),
    [outpaintImgDims.w, outpaintImgDims.h, outpaintPreset],
  );

  const renderOutpaintToCanvas = useCallback(
    (canvas: HTMLCanvasElement, img: HTMLImageElement, showGuide: boolean) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { canvasWidth, canvasHeight, drawX, drawY, drawWidth, drawHeight } = outpaintLayout;
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;

      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      // 柔和的边缘采色延展底板（取代生硬纯黑边，方便 Flow edit_image 无痕续画）
      ctx.save();
      ctx.filter = "blur(28px) brightness(0.84)";
      const coverScale = Math.max(canvasWidth / img.naturalWidth, canvasHeight / img.naturalHeight) * 1.08;
      const bw = img.naturalWidth * coverScale;
      const bh = img.naturalHeight * coverScale;
      ctx.drawImage(img, (canvasWidth - bw) / 2, (canvasHeight - bh) / 2, bw, bh);
      ctx.restore();

      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

      if (showGuide) {
        ctx.save();
        ctx.strokeStyle = "rgba(56, 189, 248, 0.85)";
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 8]);
        ctx.strokeRect(drawX + 1.5, drawY + 1.5, Math.max(2, drawWidth - 3), Math.max(2, drawHeight - 3));
        ctx.restore();
      }
    },
    [outpaintLayout],
  );

  useEffect(() => {
    if (!open || tab !== "outpaint" || !outpaintCanvasRef.current || !inpaintImgRef.current) return;
    renderOutpaintToCanvas(outpaintCanvasRef.current, inpaintImgRef.current, true);
  }, [open, tab, outpaintLayout, renderOutpaintToCanvas, sourceNode?.data.mediaId]);

  // ── Draw Tab 3 (Collage) live preview ──────────────────────────────────────
  const collagePreset = useMemo(
    () => COLLAGE_CANVAS_PRESETS.find((p) => p.key === collageAspectKey) ?? COLLAGE_CANVAS_PRESETS[0],
    [collageAspectKey],
  );

  const renderCollageToCanvas = useCallback(
    async (canvas: HTMLCanvasElement, showGuides: boolean) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = collagePreset.width;
      canvas.height = collagePreset.height;

      // 影棚纯黑渐变底色
      const grad = ctx.createRadialGradient(
        canvas.width / 2,
        canvas.height / 2,
        40,
        canvas.width / 2,
        canvas.height / 2,
        Math.max(canvas.width, canvas.height) * 0.72,
      );
      grad.addColorStop(0, "#27272c");
      grad.addColorStop(1, "#0e0e11");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const layer of collageLayers) {
        let img = collageImgCacheRef.current.get(layer.mediaId);
        if (!img) {
          try {
            img = await loadImageElement(mediaUrl(layer.mediaId));
            collageImgCacheRef.current.set(layer.mediaId, img);
          } catch {
            continue;
          }
        }
        const shortSide = Math.min(canvas.width, canvas.height);
        const targetH = shortSide * layer.scale;
        const aspect = (img.naturalWidth || 1) / Math.max(1, img.naturalHeight || 1);
        const drawH = targetH;
        const drawW = drawH * aspect;
        const cx = layer.x * canvas.width;
        const cy = layer.y * canvas.height;

        ctx.save();
        ctx.translate(cx, cy);
        if (layer.flipX) ctx.scale(-1, 1);
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();

        if (showGuides && layer.id === selectedLayerId) {
          ctx.save();
          ctx.strokeStyle = "#38bdf8";
          ctx.lineWidth = 3;
          ctx.setLineDash([8, 6]);
          ctx.strokeRect(cx - drawW / 2, cy - drawH / 2, drawW, drawH);
          ctx.restore();
        }
      }
    },
    [collageLayers, collagePreset, selectedLayerId],
  );

  useEffect(() => {
    if (!open || tab !== "collage" || !collageCanvasRef.current) return;
    void renderCollageToCanvas(collageCanvasRef.current, true);
  }, [open, tab, renderCollageToCanvas]);

  // ── Submit Actions ─────────────────────────────────────────────────────────
  async function handleUploadSeedImage() {
    const boardId = useBoardStore.getState().boardId;
    if (boardId === null || busy) return;
    setError(null);
    try {
      const files = await pickImageFiles({ multiple: false, title: "选择要精修的图片" });
      if (files.length === 0) return;
      setBusy(true);
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding?.flow_project_id) {
        setError("尚未绑定 Google Flow 项目，请先在右上角完成项目设置。");
        return;
      }
      const cleanTitle = files[0].name.replace(/\.[^.]+$/, "") || "精修素材";
      const dto = await createNode({
        board_id: boardId,
        type: "visual_asset",
        x: 120,
        y: 120,
        data: { title: cleanTitle },
      });
      const up = await uploadImage(files[0], binding.flow_project_id, dto.id, binding.flow_account_id);
      const nowIso = new Date().toISOString();
      await patchNode(dto.id, {
        status: "done",
        data: {
          mediaId: up.media_id,
          mediaIds: [up.media_id],
          aspectRatio: up.aspect_ratio,
          renderedAt: nowIso,
        },
      });
      await useBoardStore.getState().refreshBoardState();
      setSourceRfId(String(dto.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传图片失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitInpaint() {
    if (!sourceNode?.data.mediaId || !inpaintImgRef.current || busy) return;
    const region = computeMaskRegionSpec(strokes, inpaintCanvasSize.w, inpaintCanvasSize.h);
    if (!region) {
      setError("请先用画笔在左侧图像上涂抹需要修改或消除的区域。");
      return;
    }
    if (inpaintSubMode === "inpaint" && !inpaintPrompt.trim()) {
      setError("请输入希望替换或修改的内容描述（或切换为「一键消除笔」）。");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding?.flow_project_id) {
        setError("请先在右上角绑定 Google Flow 项目。");
        return;
      }

      // 构建清晰高亮引导参考图（原图 + 青蓝色涂抹区域 + 选区边界框）
      const guideCanvas = document.createElement("canvas");
      guideCanvas.width = inpaintCanvasSize.w;
      guideCanvas.height = inpaintCanvasSize.h;
      const gCtx = guideCanvas.getContext("2d");
      if (!gCtx) throw new Error("浏览器不支持 Canvas 绘制");

      gCtx.drawImage(inpaintImgRef.current, 0, 0, guideCanvas.width, guideCanvas.height);
      gCtx.save();
      gCtx.lineCap = "round";
      gCtx.lineJoin = "round";
      for (const stroke of strokes) {
        if (stroke.length === 0) continue;
        if (stroke.length === 1) {
          gCtx.fillStyle = "rgba(56, 189, 248, 0.55)";
          gCtx.beginPath();
          gCtx.arc(stroke[0].x, stroke[0].y, stroke[0].radius, 0, Math.PI * 2);
          gCtx.fill();
        } else {
          gCtx.strokeStyle = "rgba(56, 189, 248, 0.55)";
          gCtx.lineWidth = Math.max(4, stroke[0].radius * 2);
          gCtx.beginPath();
          gCtx.moveTo(stroke[0].x, stroke[0].y);
          for (let i = 1; i < stroke.length; i += 1) gCtx.lineTo(stroke[i].x, stroke[i].y);
          gCtx.stroke();
        }
      }
      gCtx.strokeStyle = "#38bdf8";
      gCtx.lineWidth = 3;
      gCtx.strokeRect(
        region.minXRatio * guideCanvas.width,
        region.minYRatio * guideCanvas.height,
        Math.max(8, (region.maxXRatio - region.minXRatio) * guideCanvas.width),
        Math.max(8, (region.maxYRatio - region.minYRatio) * guideCanvas.height),
      );
      gCtx.restore();

      const guideFile = await canvasToPngFile(guideCanvas, "layer-inpaint-guide.png");
      const uploadedGuide = await uploadImage(
        guideFile,
        binding.flow_project_id,
        undefined,
        binding.flow_account_id,
      );

      const finalPrompt = composeInpaintPrompt(inpaintSubMode, region, inpaintPrompt);
      let targetRfId = sourceNode.id;

      if (inpaintTargetMode === "child") {
        targetRfId = await createSeededDownstreamImageNode({
          sourceNodes: [sourceNode],
          title: inpaintSubMode === "erase" ? "消除笔精修" : "局部重绘",
          prompt: finalPrompt,
          seedMediaId: sourceNode.data.mediaId,
          aspectRatio: sourceNode.data.aspectRatio,
        });
      }

      await useGenerationStore.getState().refineImage(targetRfId, {
        prompt: finalPrompt,
        refMediaIds: [uploadedGuide.media_id],
        aspectRatio: sourceNode.data.aspectRatio,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "局部精修提交失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitOutpaint() {
    if (!sourceNode?.data.mediaId || !inpaintImgRef.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding?.flow_project_id) {
        setError("请先在右上角绑定 Google Flow 项目。");
        return;
      }

      const offCanvas = document.createElement("canvas");
      renderOutpaintToCanvas(offCanvas, inpaintImgRef.current, false);
      const outFile = await canvasToPngFile(offCanvas, `outpaint-${outpaintPreset}.png`);
      const uploadedPad = await uploadImage(
        outFile,
        binding.flow_project_id,
        undefined,
        binding.flow_account_id,
      );

      const finalPrompt = composeOutpaintPrompt(outpaintLayout, outpaintHint);
      const targetRfId = await createSeededDownstreamImageNode({
        sourceNodes: [sourceNode],
        title: outpaintLayout.label,
        prompt: finalPrompt,
        seedMediaId: uploadedPad.media_id,
        aspectRatio: outpaintLayout.aspectRatio,
      });

      await useGenerationStore.getState().refineImage(targetRfId, {
        prompt: finalPrompt,
        refMediaIds: [sourceNode.data.mediaId],
        aspectRatio: outpaintLayout.aspectRatio,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "比例扩图提交失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitCollage() {
    if (collageLayers.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding?.flow_project_id) {
        setError("请先在右上角绑定 Google Flow 项目。");
        return;
      }

      const flatCanvas = document.createElement("canvas");
      await renderCollageToCanvas(flatCanvas, false);
      const flatFile = await canvasToPngFile(flatCanvas, "collage-composite.png");
      const uploadedFlat = await uploadImage(
        flatFile,
        binding.flow_project_id,
        undefined,
        binding.flow_account_id,
      );

      const participatingNodes = collageLayers
        .map((l) => imageNodes.find((n) => n.id === l.rfId))
        .filter((n): n is FlowNode => Boolean(n));
      const uniqueRefIds = Array.from(new Set(collageLayers.map((l) => l.mediaId))).slice(0, 3);
      const finalPrompt = composeCollageFusionPrompt(
        collagePrompt,
        collageLayers.map((l) => l.title),
      );

      const targetRfId = await createSeededDownstreamImageNode({
        sourceNodes: participatingNodes.length > 0 ? participatingNodes : imageNodes.slice(0, 1),
        title: "拼贴光影融合",
        prompt: finalPrompt,
        seedMediaId: uploadedFlat.media_id,
        aspectRatio: collagePreset.enumVal,
      });

      await useGenerationStore.getState().refineImage(targetRfId, {
        prompt: finalPrompt,
        refMediaIds: uniqueRefIds,
        aspectRatio: collagePreset.enumVal,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "拼贴光影融合提交失败");
    } finally {
      setBusy(false);
    }
  }

  const maskRegion = useMemo(
    () => computeMaskRegionSpec(strokes, inpaintCanvasSize.w, inpaintCanvasSize.h),
    [strokes, inpaintCanvasSize.w, inpaintCanvasSize.h],
  );

  const selectedLayer = useMemo(
    () => collageLayers.find((l) => l.id === selectedLayerId) ?? null,
    [collageLayers, selectedLayerId],
  );

  if (!open) return null;

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) setOpen(false);
      }}
    >
      <div
        className="gen-dialog jm-layer-modal"
        role="dialog"
        aria-modal="true"
        aria-label="图层编辑精修画板"
      >
        <div className="gen-dialog__header">
          <div>
            <h2 className="gen-dialog__title">❖ 图层精修画板 · Flow 原生无损重绘引擎</h2>
            <span className="gen-dialog__subtitle">
              局部画笔重绘 / 消除笔 / 比例扩图 / 多节点拼贴统一光影（均走 Flow 0 积分原生重绘与历史版本记录）
            </span>
          </div>
          <button
            type="button"
            className="gen-dialog__close"
            onClick={() => !busy && setOpen(false)}
            aria-label="关闭图层编辑画板"
          >
            ✕
          </button>
        </div>

        <div className="jm-layer-modal__toolbar">
          <div className="jm-layer-modal__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "inpaint"}
              className={`aspect-chip${tab === "inpaint" ? " aspect-chip--active" : ""}`}
              onClick={() => {
                setError(null);
                setTab("inpaint");
              }}
            >
              🖌️ 局部重绘 / 消除笔
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "outpaint"}
              className={`aspect-chip${tab === "outpaint" ? " aspect-chip--active" : ""}`}
              onClick={() => {
                setError(null);
                setTab("outpaint");
              }}
            >
              ↔️ 比例扩图
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "collage"}
              className={`aspect-chip${tab === "collage" ? " aspect-chip--active" : ""}`}
              onClick={() => {
                setError(null);
                setTab("collage");
              }}
            >
              🧩 多节点拼贴融合
            </button>
          </div>

          {tab !== "collage" && imageNodes.length > 0 && (
            <label className="jm-layer-source-picker">
              <span>编辑目标节点</span>
              <select
                value={sourceNode?.id ?? ""}
                onChange={(e) => setSourceRfId(e.target.value)}
                disabled={busy}
              >
                {imageNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {displayNodeTitle(n.data.title, n.data.type)} (#{n.data.shortId})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="gen-dialog__body">
          {imageNodes.length === 0 ? (
            <div className="jm-seq-empty" style={{ padding: "36px 16px" }}>
              <p className="jm-seq-empty__title">当前画布暂无已生成的图像或主体节点</p>
              <p className="jm-seq-empty__desc">
                请先在画布中生成一张图片，或直接上传本地图片作为精修底图。
              </p>
              <button
                type="button"
                className="jm-seq-empty__btn"
                disabled={busy}
                onClick={() => void handleUploadSeedImage()}
              >
                {busy ? "正在上传到 Flow…" : "↑ 上传本地图片并开始精修"}
              </button>
            </div>
          ) : tab === "inpaint" ? (
            <div className="jm-layer-grid">
              <div className="jm-layer-stage">
                <canvas
                  ref={inpaintCanvasRef}
                  width={inpaintCanvasSize.w}
                  height={inpaintCanvasSize.h}
                  className="jm-layer-canvas jm-layer-canvas--brush"
                  onPointerDown={(e) => {
                    if (busy) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drawingRef.current = true;
                    const pt = toCanvasPoint(e);
                    setStrokes((prev) => [...prev, [pt]]);
                  }}
                  onPointerMove={(e) => {
                    if (!drawingRef.current) return;
                    const pt = toCanvasPoint(e);
                    setStrokes((prev) => {
                      if (prev.length === 0) return [[pt]];
                      const copy = [...prev];
                      copy[copy.length - 1] = [...copy[copy.length - 1], pt];
                      return copy;
                    });
                  }}
                  onPointerUp={() => {
                    drawingRef.current = false;
                  }}
                  onPointerCancel={() => {
                    drawingRef.current = false;
                  }}
                />
                <div className="jm-layer-stage__hint">
                  {maskRegion
                    ? `✓ 已标定选区：${maskRegion.percentDesc}`
                    : "在画布图像上按住鼠标左键涂抹需重绘或消除的区域"}
                </div>
              </div>

              <div className="jm-layer-sidebar">
                <div className="aspect-chip-row">
                  <button
                    type="button"
                    className={`aspect-chip${inpaintSubMode === "inpaint" ? " aspect-chip--active" : ""}`}
                    onClick={() => setInpaintSubMode("inpaint")}
                  >
                    🖌️ 局部重绘
                  </button>
                  <button
                    type="button"
                    className={`aspect-chip${inpaintSubMode === "erase" ? " aspect-chip--active" : ""}`}
                    onClick={() => setInpaintSubMode("erase")}
                  >
                    🧹 一键消除笔
                  </button>
                </div>

                <label className="jm-layer-slider">
                  <span>画笔粗细：{brushSize}px</span>
                  <input
                    type="range"
                    min={12}
                    max={80}
                    value={brushSize}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                  />
                </label>

                <div className="jm-layer-mini-actions">
                  <button
                    type="button"
                    className="jm-seq-ctrl-btn"
                    disabled={strokes.length === 0 || busy}
                    onClick={() => setStrokes((s) => s.slice(0, -1))}
                  >
                    ↩ 撤销一笔
                  </button>
                  <button
                    type="button"
                    className="jm-seq-ctrl-btn"
                    disabled={strokes.length === 0 || busy}
                    onClick={() => setStrokes([])}
                  >
                    🗑️ 清空涂抹
                  </button>
                </div>

                <div className="gen-dialog__field">
                  <span className="gen-dialog__label">
                    {inpaintSubMode === "erase"
                      ? "要消除的对象名称（可选，如：路人 / 水印文字）"
                      : "局部修改指令（例如：将涂抹区域换成金色金属细框眼镜）"}
                  </span>
                  <textarea
                    className="gen-dialog__textarea"
                    rows={3}
                    value={inpaintPrompt}
                    onChange={(e) => setInpaintPrompt(e.target.value)}
                    placeholder={
                      inpaintSubMode === "erase"
                        ? "留空将自动识别涂抹物体并无痕补全背景…"
                        : "描述你想替换进涂抹区域的新元素、材质或光影变化…"
                    }
                  />
                </div>

                <div className="aspect-chip-row">
                  <button
                    type="button"
                    className={`aspect-chip${inpaintTargetMode === "child" ? " aspect-chip--active" : ""}`}
                    onClick={() => setInpaintTargetMode("child")}
                  >
                    ✨ 新建下游精修节点
                  </button>
                  <button
                    type="button"
                    className={`aspect-chip${inpaintTargetMode === "inplace" ? " aspect-chip--active" : ""}`}
                    onClick={() => setInpaintTargetMode("inplace")}
                  >
                    🔄 原地覆盖并保留历史版
                  </button>
                </div>

                {error && <p className="visual-asset__error" role="alert">{error}</p>}

                <button
                  type="button"
                  className="gen-dialog__cta"
                  disabled={busy}
                  onClick={() => void handleSubmitInpaint()}
                >
                  {busy
                    ? "正在上传蒙版并提交 Flow…"
                    : inpaintSubMode === "erase"
                      ? "🧹 一键无痕消除 (0 积分)"
                      : "🖌️ 开始局部重绘 (0 积分)"}
                </button>
              </div>
            </div>
          ) : tab === "outpaint" ? (
            <div className="jm-layer-grid">
              <div className="jm-layer-stage">
                <canvas ref={outpaintCanvasRef} className="jm-layer-canvas" />
                <div className="jm-layer-stage__hint">
                  目标画布：{outpaintLayout.canvasWidth} × {outpaintLayout.canvasHeight}（虚线框内为锁定原图核心区）
                </div>
              </div>

              <div className="jm-layer-sidebar">
                <span className="gen-dialog__label">选择扩图比例预设</span>
                <div className="aspect-chip-row" style={{ flexWrap: "wrap" }}>
                  {OUTPAINT_PRESETS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      className={`aspect-chip${outpaintPreset === p.key ? " aspect-chip--active" : ""}`}
                      onClick={() => setOutpaintPreset(p.key)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="gen-dialog__field">
                  <span className="gen-dialog__label">周围延展场景描述（可选）</span>
                  <textarea
                    className="gen-dialog__textarea"
                    rows={3}
                    value={outpaintHint}
                    onChange={(e) => setOutpaintHint(e.target.value)}
                    placeholder="例如：两侧延展出更多复古咖啡馆木质书架与窗外霓虹雨夜街景，保持纵深感…"
                  />
                </div>

                {error && <p className="visual-asset__error" role="alert">{error}</p>}

                <button
                  type="button"
                  className="gen-dialog__cta"
                  disabled={busy}
                  onClick={() => void handleSubmitOutpaint()}
                >
                  {busy ? "正在生成延展底板并提交 Flow…" : "↔️ 生成无痕扩图 (0 积分)"}
                </button>
              </div>
            </div>
          ) : (
            <div className="jm-layer-grid">
              <div className="jm-layer-stage">
                <canvas
                  ref={collageCanvasRef}
                  className="jm-layer-canvas jm-layer-canvas--drag"
                  onPointerDown={(e) => {
                    const canvas = e.currentTarget;
                    const rect = canvas.getBoundingClientRect();
                    const nx = (e.clientX - rect.left) / Math.max(1, rect.width);
                    const ny = (e.clientY - rect.top) / Math.max(1, rect.height);
                    // 从顶层向下命中图层
                    for (let i = collageLayers.length - 1; i >= 0; i -= 1) {
                      const layer = collageLayers[i];
                      const half = layer.scale * 0.45;
                      if (Math.abs(nx - layer.x) <= half && Math.abs(ny - layer.y) <= half) {
                        setSelectedLayerId(layer.id);
                        dragLayerRef.current = {
                          layerId: layer.id,
                          offsetX: nx - layer.x,
                          offsetY: ny - layer.y,
                        };
                        canvas.setPointerCapture(e.pointerId);
                        return;
                      }
                    }
                    setSelectedLayerId(null);
                  }}
                  onPointerMove={(e) => {
                    const drag = dragLayerRef.current;
                    if (!drag) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const nx = (e.clientX - rect.left) / Math.max(1, rect.width);
                    const ny = (e.clientY - rect.top) / Math.max(1, rect.height);
                    setCollageLayers((prev) =>
                      prev.map((l) =>
                        l.id === drag.layerId
                          ? {
                              ...l,
                              x: Math.max(0.05, Math.min(0.95, nx - drag.offsetX)),
                              y: Math.max(0.05, Math.min(0.95, ny - drag.offsetY)),
                            }
                          : l,
                      ),
                    );
                  }}
                  onPointerUp={() => {
                    dragLayerRef.current = null;
                  }}
                  onPointerCancel={() => {
                    dragLayerRef.current = null;
                  }}
                />
                <div className="jm-layer-stage__hint">
                  在画布上拖拽各素材图层调整构图站位与前后遮挡关系（虚线框为当前选中图层）
                </div>
              </div>

              <div className="jm-layer-sidebar">
                <div className="aspect-chip-row">
                  {COLLAGE_CANVAS_PRESETS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      className={`aspect-chip${collageAspectKey === p.key ? " aspect-chip--active" : ""}`}
                      onClick={() => setCollageAspectKey(p.key)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div>
                  <span className="gen-dialog__label">点击画板节点添加为图层</span>
                  <div className="jm-layer-asset-chips">
                    {imageNodes.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        className="jm-layer-asset-chip"
                        onClick={() => {
                          if (!n.data.mediaId) return;
                          const offset = (collageLayers.length % 4) * 0.08;
                          const newLayer: CollageLayerItem = {
                            id: `layer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                            rfId: n.id,
                            mediaId: n.data.mediaId,
                            title: displayNodeTitle(n.data.title, n.data.type),
                            x: Math.min(0.82, 0.34 + offset),
                            y: 0.52,
                            scale: 0.52,
                            flipX: false,
                          };
                          setCollageLayers((prev) => [...prev, newLayer]);
                          setSelectedLayerId(newLayer.id);
                        }}
                      >
                        <img src={mediaUrl(n.data.mediaId!)} alt="" />
                        <span>+ {displayNodeTitle(n.data.title, n.data.type)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {selectedLayer && (
                  <div className="jm-layer-inspector">
                    <div className="jm-layer-inspector__head">
                      <strong>图层：{selectedLayer.title}</strong>
                      <button
                        type="button"
                        className="jm-seq-ctrl-btn"
                        onClick={() => {
                          setCollageLayers((prev) => prev.filter((l) => l.id !== selectedLayer.id));
                          setSelectedLayerId(null);
                        }}
                      >
                        ✕ 移除
                      </button>
                    </div>
                    <label className="jm-layer-slider">
                      <span>缩放：{Math.round(selectedLayer.scale * 100)}%</span>
                      <input
                        type="range"
                        min={20}
                        max={140}
                        value={Math.round(selectedLayer.scale * 100)}
                        onChange={(e) => {
                          const scale = Number(e.target.value) / 100;
                          setCollageLayers((prev) =>
                            prev.map((l) => (l.id === selectedLayer.id ? { ...l, scale } : l)),
                          );
                        }}
                      />
                    </label>
                    <div className="jm-layer-mini-actions">
                      <button
                        type="button"
                        className="jm-seq-ctrl-btn"
                        onClick={() =>
                          setCollageLayers((prev) =>
                            prev.map((l) =>
                              l.id === selectedLayer.id ? { ...l, flipX: !l.flipX } : l,
                            ),
                          )
                        }
                      >
                        ⇄ 镜像翻转
                      </button>
                      <button
                        type="button"
                        className="jm-seq-ctrl-btn"
                        onClick={() =>
                          setCollageLayers((prev) => {
                            const idx = prev.findIndex((l) => l.id === selectedLayer.id);
                            if (idx < 0 || idx === prev.length - 1) return prev;
                            const next = [...prev];
                            const [item] = next.splice(idx, 1);
                            next.splice(idx + 1, 0, item);
                            return next;
                          })
                        }
                      >
                        ↑ 上移一层
                      </button>
                    </div>
                  </div>
                )}

                <div className="gen-dialog__field">
                  <span className="gen-dialog__label">统一场景与光影融合描述</span>
                  <textarea
                    className="gen-dialog__textarea"
                    rows={2}
                    value={collagePrompt}
                    onChange={(e) => setCollagePrompt(e.target.value)}
                    placeholder="例如：统一为黄昏逆光户外氛围，补充角色脚下真实投影与冷暖色调融合…"
                  />
                </div>

                {error && <p className="visual-asset__error" role="alert">{error}</p>}

                <button
                  type="button"
                  className="gen-dialog__cta"
                  disabled={collageLayers.length === 0 || busy}
                  onClick={() => void handleSubmitCollage()}
                >
                  {busy ? "正在扁平化拼贴并提交 Flow 融合…" : "🧩 合成拼贴并光影融合 (0 积分)"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
