/**
 * 故事板一键切分器：在纯浏览器端将 NxM 故事板大图按宫格无损裁剪（自动内缩剔除分隔白边），
 * 调用 Flow `maseQ` 上传注册标准 mediaId，并在画布右侧生成独立分镜节点并自动连线。
 */
import { createEdge, createNode, mediaUrl, patchNode, uploadImage } from "../api/client";
import { useBoardStore, type FlowNode } from "../store/board";
import { useGenerationStore } from "../store/generation";
import {
  normaliseStoryboardGrid,
  resolveStoryboardLayout,
} from "./storyboardPrompt";

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("无法加载故事板原图，请先确认画面已缓存完成"));
    img.src = src;
  });
}

function canvasToPngFile(canvas: HTMLCanvasElement, filename: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`导出分镜切片 ${filename} 失败`));
          return;
        }
        resolve(new File([blob], filename, { type: "image/png" }));
      },
      "image/png",
      0.95,
    );
  });
}

export async function splitStoryboardToShotNodes(
  storyboardRfId: string,
  variantIdx = 0,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const boardState = useBoardStore.getState();
  const boardId = boardState.boardId;
  const srcNode = boardState.nodes.find((n) => n.id === storyboardRfId);
  if (boardId === null || !srcNode) {
    throw new Error("未找到目标故事板节点");
  }
  const candidateId =
    srcNode.data.mediaIds?.[variantIdx] ??
    srcNode.data.mediaId ??
    srcNode.data.mediaIds?.find((m): m is string => typeof m === "string" && m.length > 0);
  if (!candidateId) {
    throw new Error("故事板尚未生成图像，请先生成后再切分");
  }

  const binding = await useGenerationStore.getState().ensureProjectBinding();
  if (!binding?.flow_project_id) {
    throw new Error("请先在右上角绑定 Flow 项目后再执行切分注册");
  }

  const grid = normaliseStoryboardGrid(srcNode.data.storyboardGrid);
  const { rows, cols, total } = resolveStoryboardLayout(grid, srcNode.data.aspectRatio);
  const img = await loadImageElement(mediaUrl(candidateId));
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (width < 32 || height < 32) {
    throw new Error("故事板图片尺寸异常，无法切分");
  }

  const cellW = width / cols;
  const cellH = height / rows;
  // 内缩约 2% 剔除宫格白边分隔线，保持每张分镜边界干净
  const gutterX = Math.max(1, Math.round(cellW * 0.02));
  const gutterY = Math.max(1, Math.round(cellH * 0.02));
  const cropW = Math.max(16, Math.floor(cellW - gutterX * 2));
  const cropH = Math.max(16, Math.floor(cellH - gutterY * 2));

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  const ctx = cropCanvas.getContext("2d");
  if (!ctx) {
    throw new Error("浏览器不支持 Canvas 2D 图像处理");
  }

  const nowIso = new Date().toISOString();
  const createdNodes: FlowNode[] = [];
  const createdEdges: ReturnType<typeof useBoardStore.getState>["edges"] = [];
  const baseTitle = srcNode.data.aiBrief || srcNode.data.prompt || "故事板分镜";
  const srcDbId = parseInt(srcNode.id, 10);

  let idx = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      idx += 1;
      const sx = Math.round(c * cellW + gutterX);
      const sy = Math.round(r * cellH + gutterY);
      ctx.clearRect(0, 0, cropW, cropH);
      ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, cropW, cropH);

      const file = await canvasToPngFile(cropCanvas, `storyboard-shot-${idx}.png`);
      const uploadResp = await uploadImage(
        file,
        binding.flow_project_id,
        undefined,
        binding.flow_account_id,
      );
      const shotTitle = `分镜 #${idx}`;
      const x = Math.round(srcNode.position.x + 360 + c * 296);
      const y = Math.round(srcNode.position.y + (r - (rows - 1) / 2) * 265);
      const shotAspect = uploadResp.aspect_ratio || srcNode.data.aspectRatio;
      const historyEntry = {
        mediaId: uploadResp.media_id,
        mediaIds: [uploadResp.media_id],
        prompt: `${baseTitle} — 第 ${idx}/${total} 镜`,
        renderedAt: nowIso,
        aspectRatio: shotAspect,
      };

      const dto = await createNode({
        board_id: boardId,
        type: "image",
        x,
        y,
        data: {
          title: shotTitle,
          status: "done",
          mediaId: uploadResp.media_id,
          mediaIds: [uploadResp.media_id],
          variantCount: 1,
          aspectRatio: shotAspect,
          prompt: historyEntry.prompt,
          renderedAt: nowIso,
          history: [historyEntry],
        },
      });
      await patchNode(dto.id, {
        status: "done",
        data: {
          title: shotTitle,
          mediaId: uploadResp.media_id,
          mediaIds: [uploadResp.media_id],
          variantCount: 1,
          aspectRatio: shotAspect,
          prompt: historyEntry.prompt,
          renderedAt: nowIso,
          history: [historyEntry],
        },
      }).catch(() => {});

      const rfNode: FlowNode = {
        id: String(dto.id),
        type: "image",
        position: { x: dto.x, y: dto.y },
        data: {
          type: "image",
          shortId: dto.short_id,
          title: shotTitle,
          status: "done",
          mediaId: uploadResp.media_id,
          mediaIds: [uploadResp.media_id],
          variantCount: 1,
          aspectRatio: shotAspect,
          prompt: historyEntry.prompt,
          renderedAt: nowIso,
          history: [historyEntry],
        },
      };
      createdNodes.push(rfNode);

      if (!isNaN(srcDbId)) {
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
          // non-fatal
        }
      }
      onProgress?.(idx, total);
    }
  }

  useBoardStore.setState((s) => ({
    nodes: [...s.nodes, ...createdNodes],
    edges: [...s.edges, ...createdEdges],
  }));
  return createdNodes.map((n) => n.id);
}
