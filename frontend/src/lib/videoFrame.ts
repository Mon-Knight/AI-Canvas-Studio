/**
 * 浏览器端视频关键帧提取与上传工具。
 *
 * Google Flow 的图片参考端点（ogiZ0b / MZZa6b / eb1hJf）仅接收已上传的图片 media_id，
 * 不直接接收 .mp4 视频句柄。本模块使用离屏 <video> + <canvas> 抽取上游视频节点的
 * 尾帧（默认）或首帧 JPEG 并经由 POST /api/upload（maseQ）上传为可引用的图片 media_id，
 * 再缓存于上游节点的 data.videoFrameCache[`${videoMediaId}:${mode}`]，避免重复抽帧上传。
 *
 * 注意：禁止在模块顶层访问 document / window，确保 Node SSR 测试可直接导入。
 */

import { mediaUrl, uploadImage } from "../api/client";

export type VideoRefFrameMode = "last" | "first";

const inFlightResolutions = new Map<string, Promise<string>>();

export async function extractVideoFrameFile(
  videoMediaId: string,
  mode: VideoRefFrameMode = "last",
): Promise<File> {
  if (typeof document === "undefined") {
    throw new Error("视频抽帧仅可在浏览器环境中执行");
  }

  const src = mediaUrl(videoMediaId);

  return new Promise<File>((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // ignore cleanup errors
      }
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = window.setTimeout(() => {
      fail(new Error("读取上游视频超时，无法提取参考帧（请确认视频已加载完成）"));
    }, 15_000);

    const handleError = () => {
      fail(new Error("无法解码上游视频文件，请确认视频已正常播放或重新生成"));
    };

    const handleSeeked = () => {
      if (settled) return;
      try {
        const width = video.videoWidth || 1280;
        const height = video.videoHeight || 720;
        if (width <= 0 || height <= 0) {
          fail(new Error("上游视频尺寸无效，无法抽帧"));
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          fail(new Error("无法创建 Canvas 2D 上下文进行视频抽帧"));
          return;
        }
        ctx.drawImage(video, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (settled) return;
            if (!blob) {
              fail(new Error("视频抽帧导出 JPEG 失败"));
              return;
            }
            settled = true;
            cleanup();
            const safeName = videoMediaId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
            resolve(
              new File([blob], `${safeName || "video"}-${mode}.jpg`, {
                type: "image/jpeg",
              }),
            );
          },
          "image/jpeg",
          0.92,
        );
      } catch (err) {
        fail(err);
      }
    };

    const handleLoadedMetadata = () => {
      if (settled) return;
      const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const targetTime =
        mode === "first"
          ? Math.min(0.05, dur > 0 ? dur * 0.05 : 0)
          : Math.max(0, dur - 0.08);
      if (Math.abs(video.currentTime - targetTime) < 0.01 && video.readyState >= 2) {
        handleSeeked();
        return;
      }
      try {
        video.currentTime = targetTime;
      } catch {
        handleSeeked();
      }
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("error", handleError);
    video.src = src;
    video.load();
  });
}

export async function resolveVideoRefAsImageMediaId(opts: {
  videoMediaId: string;
  mode?: VideoRefFrameMode;
  projectId: string;
  nodeId?: number;
  flowAccountId?: string | null;
  existingCache?: Record<string, string>;
  onCacheUpdate?: (cacheKey: string, imageMediaId: string) => void;
}): Promise<string> {
  const mode: VideoRefFrameMode = opts.mode ?? "last";
  const cacheKey = `${opts.videoMediaId}:${mode}`;
  const cached = opts.existingCache?.[cacheKey];
  if (cached) return cached;

  const dedupeKey = `${opts.projectId}:${opts.flowAccountId ?? ""}:${cacheKey}`;
  const existingFlight = inFlightResolutions.get(dedupeKey);
  if (existingFlight) return existingFlight;

  const task = (async () => {
    const file = await extractVideoFrameFile(opts.videoMediaId, mode);
    const uploaded = await uploadImage(
      file,
      opts.projectId,
      opts.nodeId,
      opts.flowAccountId,
    );
    opts.onCacheUpdate?.(cacheKey, uploaded.media_id);
    return uploaded.media_id;
  })().finally(() => {
    inFlightResolutions.delete(dedupeKey);
  });

  inFlightResolutions.set(dedupeKey, task);
  return task;
}
