/**
 * Pure TypeScript utilities for the Flow-style Video Showcase page:
 * - SMPTE-like timecode formatting (`MM:SS:FF` at 24fps)
 * - Client-side filmstrip keyframe extraction via offscreen <video> + <canvas>
 * - Zero-dependency GIF89a animated encoder & 270p GIF export
 */

export function formatVideoTimecode(seconds: number, fps = 24): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00:00";
  const totalFrames = Math.max(0, Math.round(seconds * fps));
  const frames = totalFrames % fps;
  const totalSec = Math.floor(totalFrames / fps);
  const secs = totalSec % 60;
  const mins = Math.floor(totalSec / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(mins)}:${pad(secs)}:${pad(frames)}`;
}

// 256-entry global color table: 216-color 6x6x6 RGB cube + 40 neutral grayscale ramp.
function buildGifPalette(): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  let idx = 0;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        palette[idx++] = Math.round((r * 255) / 5);
        palette[idx++] = Math.round((g * 255) / 5);
        palette[idx++] = Math.round((b * 255) / 5);
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    const v = Math.round((i * 255) / 39);
    palette[idx++] = v;
    palette[idx++] = v;
    palette[idx++] = v;
  }
  return palette;
}

function quantizeRgbaToPalette(rgba: Uint8ClampedArray): Uint8Array {
  const pixelCount = rgba.length >> 2;
  const out = new Uint8Array(pixelCount);
  for (let p = 0, o = 0; p < rgba.length; p += 4, o++) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const maxCh = r > g ? (r > b ? r : b) : g > b ? g : b;
    const minCh = r < g ? (r < b ? r : b) : g < b ? g : b;
    if (maxCh - minCh <= 8) {
      const lum = (r * 77 + g * 150 + b * 29) >> 8;
      out[o] = 216 + Math.min(39, Math.round((lum * 39) / 255));
    } else {
      const ri = Math.round((r * 5) / 255);
      const gi = Math.round((g * 5) / 255);
      const bi = Math.round((b * 5) / 255);
      out[o] = ri * 36 + gi * 6 + bi;
    }
  }
  return out;
}

function lzwEncodeGif(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;

  const emitCode = (code: number, size: number) => {
    bitBuf |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };

  let dict = new Map<number, number>();
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;

  const resetDict = () => {
    dict = new Map<number, number>();
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };

  emitCode(clearCode, codeSize);
  if (indices.length > 0) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
      } else {
        emitCode(prefix, codeSize);
        if (nextCode < 4096) {
          dict.set(key, nextCode++);
          if (nextCode > (1 << codeSize) && codeSize < 12) {
            codeSize++;
          }
        } else {
          emitCode(clearCode, codeSize);
          resetDict();
        }
        prefix = k;
      }
    }
    emitCode(prefix, codeSize);
  }
  emitCode(eoiCode, codeSize);
  if (bitCount > 0) {
    out.push(bitBuf & 0xff);
  }

  // Package into GIF sub-blocks (max 255 bytes each) + block terminator 0x00.
  const subBlocks: number[] = [minCodeSize];
  for (let i = 0; i < out.length; i += 255) {
    const chunkLen = Math.min(255, out.length - i);
    subBlocks.push(chunkLen);
    for (let j = 0; j < chunkLen; j++) {
      subBlocks.push(out[i + j]);
    }
  }
  subBlocks.push(0x00);
  return new Uint8Array(subBlocks);
}

/**
 * Encode RGBA frames into a valid animated GIF89a byte array.
 * `delayCs` is frame delay in centiseconds (e.g. 12 ≈ 8.3fps).
 */
export function encodeGif89a(
  frames: Uint8ClampedArray[],
  width: number,
  height: number,
  delayCs = 12,
): Uint8Array {
  const w = Math.max(1, Math.min(65535, Math.round(width)));
  const h = Math.max(1, Math.min(65535, Math.round(height)));
  const palette = buildGifPalette();
  const chunks: Uint8Array[] = [];

  // Header + Logical Screen Descriptor (256-color GCT: 0xF7)
  chunks.push(
    new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
      w & 0xff, (w >> 8) & 0xff,
      h & 0xff, (h >> 8) & 0xff,
      0xf7, 0x00, 0x00,
    ]),
  );
  chunks.push(palette);

  // NETSCAPE2.0 Application Extension (infinite loop)
  chunks.push(
    new Uint8Array([
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
      0x03, 0x01, 0x00, 0x00, 0x00,
    ]),
  );

  const delay = Math.max(2, Math.min(65535, Math.round(delayCs)));
  for (const rgba of frames) {
    // Graphic Control Extension
    chunks.push(
      new Uint8Array([
        0x21, 0xf9, 0x04, 0x04,
        delay & 0xff, (delay >> 8) & 0xff,
        0x00, 0x00,
      ]),
    );
    // Image Descriptor
    chunks.push(
      new Uint8Array([
        0x2c,
        0x00, 0x00, 0x00, 0x00,
        w & 0xff, (w >> 8) & 0xff,
        h & 0xff, (h >> 8) & 0xff,
        0x00,
      ]),
    );
    chunks.push(lzwEncodeGif(quantizeRgbaToPalette(rgba), 8));
  }

  // Trailer
  chunks.push(new Uint8Array([0x3b]));

  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function seekVideoTo(video: HTMLVideoElement, targetSec: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", finish);
      video.removeEventListener("error", finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, 1800);
    video.addEventListener("seeked", finish, { once: true });
    video.addEventListener("error", finish, { once: true });
    try {
      video.currentTime = Math.max(0, targetSec);
    } catch {
      finish();
    }
  });
}

function loadOffscreenVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const onLoaded = () => {
      cleanup();
      resolve(video);
    };
    const onErr = () => {
      cleanup();
      reject(new Error("无法读取视频帧数据"));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("读取视频超时"));
    }, 12000);
    const cleanup = () => {
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onErr);
      window.clearTimeout(timer);
    };
    video.addEventListener("loadeddata", onLoaded, { once: true });
    video.addEventListener("error", onErr, { once: true });
    video.src = url;
    video.load();
  });
}

/**
 * Sample evenly-spaced thumbnails from a video URL for the Flow filmstrip timeline.
 */
export async function extractVideoFilmstripFrames(
  videoUrl: string,
  frameCount = 12,
  thumbHeight = 64,
): Promise<string[]> {
  const video = await loadOffscreenVideo(videoUrl);
  try {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const outH = Math.max(36, Math.min(96, thumbHeight));
    const outW = Math.max(36, Math.round((vw / vh) * outH));
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    const count = Math.max(4, Math.min(24, frameCount));
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(Math.max(0, duration - 0.08), ((i + 0.5) / count) * duration);
      await seekVideoTo(video, t);
      ctx.drawImage(video, 0, 0, outW, outH);
      urls.push(canvas.toDataURL("image/jpeg", 0.68));
    }
    return urls;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * Export a video URL as a 270p animated GIF and trigger browser download.
 */
export async function exportVideoUrlAsGif270p(
  videoUrl: string,
  filename: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  onProgress?.(5);
  const video = await loadOffscreenVideo(videoUrl);
  try {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 6;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const targetH = vw >= vh ? 270 : Math.min(360, Math.round((270 * vh) / vw));
    const targetW = Math.max(120, Math.round((vw / vh) * targetH));
    // Keep GIF dimensions even & bounded for fast browser encoding
    const outW = Math.min(480, targetW - (targetW % 2));
    const outH = Math.min(480, targetH - (targetH % 2));

    const fps = 8;
    const maxSeconds = Math.min(duration, 10);
    const totalFrames = Math.max(6, Math.min(64, Math.round(maxSeconds * fps)));
    const delayCs = Math.max(8, Math.round(100 / fps));

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("浏览器 Canvas 不可用");

    const frames: Uint8ClampedArray[] = [];
    for (let i = 0; i < totalFrames; i++) {
      const t = Math.min(Math.max(0, duration - 0.05), (i / totalFrames) * maxSeconds);
      await seekVideoTo(video, t);
      ctx.drawImage(video, 0, 0, outW, outH);
      frames.push(ctx.getImageData(0, 0, outW, outH).data);
      onProgress?.(10 + Math.round(((i + 1) / totalFrames) * 75));
    }

    onProgress?.(90);
    const bytes = encodeGif89a(frames, outW, outH, delayCs);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "image/gif" });
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename.endsWith(".gif") ? filename : `${filename}.gif`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
    onProgress?.(100);
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}
