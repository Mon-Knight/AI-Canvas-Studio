/**
 * 纯浏览器原生时间线成片合成导出器（Stage 3B）：
 * - 基于 <canvas> captureStream(30) + WebAudio API 混音 + MediaRecorder
 * - 零外部 ffmpeg 依赖，同时兼容 Chrome 网页端与 Electron 桌面端
 * - 支持图片定格时长/微缩放推镜 + 视频原声 + 全局 BGM/旁白音轨混音导出
 */

export interface TimelineExportShotInput {
  key: string;
  title: string;
  kind: "image" | "video";
  mediaUrl: string;
  imageDurationSec: number;
}

export interface TimelineExportProgress {
  shotIndex: number;
  totalShots: number;
  percent: number;
  label: string;
}

const RECORDER_MIME_CANDIDATES: ReadonlyArray<{ mime: string; ext: "mp4" | "webm" }> = [
  { mime: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4" },
  { mime: "video/mp4", ext: "mp4" },
  { mime: "video/webm;codecs=vp9,opus", ext: "webm" },
  { mime: "video/webm;codecs=vp8,opus", ext: "webm" },
  { mime: "video/webm", ext: "webm" },
];

export function pickSupportedVideoRecorderMime(): { mimeType: string; ext: "mp4" | "webm" } {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return { mimeType: "video/webm", ext: "webm" };
  }
  for (const c of RECORDER_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) {
        return { mimeType: c.mime, ext: c.ext };
      }
    } catch {
      // try next candidate
    }
  }
  return { mimeType: "", ext: "webm" };
}

/** 计算等比容纳（object-fit: contain）居中矩形，支持微缩放倍率。 */
export function computeContainRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  zoom = 1,
): { dx: number; dy: number; dw: number; dh: number } {
  const safeSrcW = Math.max(1, srcW);
  const safeSrcH = Math.max(1, srcH);
  const scale = Math.min(dstW / safeSrcW, dstH / safeSrcH) * Math.max(0.5, zoom);
  const dw = safeSrcW * scale;
  const dh = safeSrcH * scale;
  return {
    dx: (dstW - dw) / 2,
    dy: (dstH - dh) / 2,
    dw,
    dh,
  };
}

function loadExportImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("读取图片帧失败"));
    img.src = src;
  });
}

function loadExportVideo(src: string, muted: boolean): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const vid = document.createElement("video");
    vid.crossOrigin = "anonymous";
    vid.playsInline = true;
    vid.preload = "auto";
    vid.muted = muted;

    const cleanup = () => {
      vid.removeEventListener("canplay", onReady);
      vid.removeEventListener("error", onErr);
    };
    const onReady = () => {
      cleanup();
      resolve(vid);
    };
    const onErr = () => {
      cleanup();
      reject(new Error("读取视频镜头失败"));
    };
    vid.addEventListener("canplay", onReady);
    vid.addEventListener("error", onErr);
    vid.src = src;
  });
}

async function detectCanvasResolution(
  firstShot: TimelineExportShotInput,
): Promise<{ width: number; height: number }> {
  try {
    if (firstShot.kind === "image") {
      const img = await loadExportImage(firstShot.mediaUrl);
      if (img.naturalHeight > img.naturalWidth) {
        return { width: 720, height: 1280 };
      }
      return { width: 1280, height: 720 };
    }
    const vid = await loadExportVideo(firstShot.mediaUrl, true);
    if (vid.videoHeight > vid.videoWidth) {
      return { width: 720, height: 1280 };
    }
  } catch {
    // default landscape HD
  }
  return { width: 1280, height: 720 };
}

export async function exportTimelineSequenceVideo(opts: {
  shots: TimelineExportShotInput[];
  bgmUrl?: string | null;
  bgmVolume?: number;
  bgmFadeOutSec?: number;
  videoAudioMuted?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: TimelineExportProgress) => void;
}): Promise<{ blob: Blob; ext: "mp4" | "webm"; mimeType: string }> {
  const {
    shots,
    bgmUrl,
    bgmVolume = 0.65,
    bgmFadeOutSec = 2,
    videoAudioMuted = false,
    signal,
    onProgress,
  } = opts;
  if (shots.length === 0) {
    throw new Error("没有可导出的启用镜头");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("当前浏览器环境不支持 MediaRecorder 成片导出");
  }

  const { width, height } = await detectCanvasResolution(shots[0]);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("浏览器不支持 2D Canvas 合成渲染");
  }

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = AudioCtx ? new AudioCtx() : null;
  const audioDest = audioCtx ? audioCtx.createMediaStreamDestination() : null;

  // 注入零增益静音时钟振荡器，确保纯静态图片镜头也有连续音频时间戳防止录制卡顿
  let silentOsc: OscillatorNode | null = null;
  if (audioCtx && audioDest) {
    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }
    silentOsc = audioCtx.createOscillator();
    const zeroGain = audioCtx.createGain();
    zeroGain.gain.value = 0;
    silentOsc.connect(zeroGain);
    zeroGain.connect(audioDest);
    silentOsc.start();
  }

  let bgmEl: HTMLAudioElement | null = null;
  let bgmGain: GainNode | null = null;
  if (bgmUrl && audioCtx && audioDest) {
    bgmEl = document.createElement("audio");
    bgmEl.crossOrigin = "anonymous";
    bgmEl.loop = true;
    bgmEl.src = bgmUrl;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const timer = window.setTimeout(done, 4000);
      bgmEl!.addEventListener("canplay", () => {
        window.clearTimeout(timer);
        done();
      }, { once: true });
      bgmEl!.addEventListener("error", () => {
        window.clearTimeout(timer);
        done();
      }, { once: true });
    });
    try {
      const bgmSource = audioCtx.createMediaElementSource(bgmEl);
      bgmGain = audioCtx.createGain();
      bgmGain.gain.value = Math.max(0, Math.min(1, bgmVolume));
      bgmSource.connect(bgmGain);
      bgmGain.connect(audioDest);
    } catch {
      // non-fatal if BGM source connection fails
    }
  }

  const canvasStream = canvas.captureStream(30);
  const tracks: MediaStreamTrack[] = [
    ...canvasStream.getVideoTracks(),
    ...(audioDest ? audioDest.stream.getAudioTracks() : []),
  ];
  const mixedStream = new MediaStream(tracks);
  const { mimeType, ext } = pickSupportedVideoRecorderMime();
  const recorder = mimeType
    ? new MediaRecorder(mixedStream, { mimeType, videoBitsPerSecond: 6_000_000 })
    : new MediaRecorder(mixedStream, { videoBitsPerSecond: 6_000_000 });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  const stopPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      const finalMime = recorder.mimeType || mimeType || "video/webm";
      resolve(new Blob(chunks, { type: finalMime }));
    };
    recorder.onerror = () => reject(new Error("成片视频编码写入失败"));
  });

  recorder.start(250);
  if (bgmEl) {
    await bgmEl.play().catch(() => {});
  }

  try {
    for (let i = 0; i < shots.length; i += 1) {
      if (signal?.aborted) {
        throw new Error("已取消成片导出");
      }
      const shot = shots[i];
      const basePct = Math.round((i / shots.length) * 100);
      onProgress?.({
        shotIndex: i,
        totalShots: shots.length,
        percent: basePct,
        label: `正在合成第 ${i + 1}/${shots.length} 镜 · ${shot.title}…`,
      });

      if (shot.kind === "image") {
        const img = await loadExportImage(shot.mediaUrl);
        const durationMs = Math.max(1000, Math.round(shot.imageDurationSec * 1000));
        await new Promise<void>((resolve, reject) => {
          const startedAt = performance.now();
          const draw = () => {
            if (signal?.aborted) {
              window.clearInterval(timer);
              reject(new Error("已取消成片导出"));
              return;
            }
            const elapsed = performance.now() - startedAt;
            const t = Math.min(1, elapsed / durationMs);
            const zoom = 1 + t * 0.03;
            ctx.fillStyle = "#09090b";
            ctx.fillRect(0, 0, width, height);
            const r = computeContainRect(img.naturalWidth, img.naturalHeight, width, height, zoom);
            ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);

            const totalPct = Math.min(99, Math.round(((i + t) / shots.length) * 100));
            onProgress?.({
              shotIndex: i,
              totalShots: shots.length,
              percent: totalPct,
              label: `正在合成第 ${i + 1}/${shots.length} 镜 (${totalPct}%)…`,
            });
            if (elapsed >= durationMs) {
              window.clearInterval(timer);
              resolve();
            }
          };
          draw();
          const timer = window.setInterval(draw, 33);
        });
      } else {
        const vid = await loadExportVideo(shot.mediaUrl, videoAudioMuted);
        if (!videoAudioMuted && audioCtx && audioDest) {
          try {
            const vidSrc = audioCtx.createMediaElementSource(vid);
            vidSrc.connect(audioDest);
          } catch {
            // silent or non-connectable track
          }
        }
        vid.currentTime = 0;
        await vid.play();

        const vidDurationMs =
          Number.isFinite(vid.duration) && vid.duration > 0
            ? Math.min(30_000, Math.round(vid.duration * 1000))
            : 15_000;

        await new Promise<void>((resolve, reject) => {
          let finished = false;
          const finish = (err?: Error) => {
            if (finished) return;
            finished = true;
            window.clearInterval(frameTimer);
            window.clearTimeout(safetyTimer);
            vid.pause();
            vid.removeEventListener("ended", onEnded);
            vid.removeEventListener("error", onErr);
            if (err) reject(err);
            else resolve();
          };
          const onEnded = () => finish();
          const onErr = () => finish();
          vid.addEventListener("ended", onEnded, { once: true });
          vid.addEventListener("error", onErr, { once: true });

          const safetyTimer = window.setTimeout(() => finish(), vidDurationMs + 800);
          const frameTimer = window.setInterval(() => {
            if (signal?.aborted) {
              finish(new Error("已取消成片导出"));
              return;
            }
            ctx.fillStyle = "#09090b";
            ctx.fillRect(0, 0, width, height);
            const r = computeContainRect(vid.videoWidth || width, vid.videoHeight || height, width, height, 1);
            ctx.drawImage(vid, r.dx, r.dy, r.dw, r.dh);

            const t =
              Number.isFinite(vid.duration) && vid.duration > 0
                ? Math.min(1, vid.currentTime / vid.duration)
                : 0.5;
            const totalPct = Math.min(99, Math.round(((i + t) / shots.length) * 100));
            onProgress?.({
              shotIndex: i,
              totalShots: shots.length,
              percent: totalPct,
              label: `正在录制第 ${i + 1}/${shots.length} 镜 (${totalPct}%)…`,
            });
          }, 33);
        });
      }
    }

    onProgress?.({
      shotIndex: shots.length - 1,
      totalShots: shots.length,
      percent: 100,
      label: "正在封装导出视频文件…",
    });
    if (bgmGain && audioCtx && bgmFadeOutSec > 0 && !signal?.aborted) {
      const fadeDur = Math.min(2.0, Math.max(0.25, bgmFadeOutSec));
      const now = audioCtx.currentTime;
      try {
        bgmGain.gain.cancelScheduledValues(now);
        bgmGain.gain.setValueAtTime(bgmGain.gain.value, now);
        bgmGain.gain.linearRampToValueAtTime(0.0001, now + fadeDur);
        await new Promise((r) => window.setTimeout(r, Math.round(fadeDur * 1000)));
      } catch {
        // non-fatal fade ramp fallback
      }
    }
  } finally {
    if (bgmEl) {
      bgmEl.pause();
      bgmEl.src = "";
    }
    if (silentOsc) {
      try {
        silentOsc.stop();
      } catch {
        // ignore
      }
    }
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  }

  try {
    const blob = await stopPromise;
    return { blob, ext, mimeType: recorder.mimeType || mimeType || "video/webm" };
  } finally {
    tracks.forEach((t) => t.stop());
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
    }
  }
}
