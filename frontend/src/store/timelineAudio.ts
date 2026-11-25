/**
 * 时间线配乐轨、镜头顺序/时长编排 & 声画导演状态仓库（Stage 3B）：
 * - 人声音色预设 + 环境声场预设 + 结构化【声画指令】拼接器
 * - 本地 BGM / 旁白音轨管理（ObjectURL 安全释放与音量混音开关）
 * - 时间线镜头自定义排序、剔除/保留勾选与图片停留时长覆盖
 */
import { create } from "zustand";

export interface VoicePreset {
  key: string;
  label: string;
  directive: string;
}

export interface AmbiencePreset {
  key: string;
  label: string;
  directive: string;
}

export const VOICE_PRESETS: readonly VoicePreset[] = [
  { key: "gentle_narration", label: "温柔治愈旁白", directive: "温柔治愈旁白，语气松弛真诚，娓娓道来" },
  { key: "deep_cinema_male", label: "电影深沉男声", directive: "电影深沉男声，胸腔共鸣质感，情绪克制有张力" },
  { key: "bright_girl", label: "清亮元气少女", directive: "清亮元气少女音，咬字灵动自然，富有感染力" },
  { key: "suspense_whisper", label: "悬疑低沉耳语", directive: "悬疑低沉耳语，节奏紧凑微颤，近距离呼吸感" },
  { key: "epic_commercial", label: "激昂商业解说", directive: "激昂商业大片解说嗓音，节奏明快充满力量" },
] as const;

export const AMBIENCE_PRESETS: readonly AmbiencePreset[] = [
  { key: "city_rain_neon", label: "城市霓虹雨夜环境声", directive: "细腻雨滴打在玻璃与沥青路面声，远处轻微车流环境底噪" },
  { key: "forest_breeze", label: "自然微风与林间鸟鸣", directive: "清晨微风拂过树叶沙沙声与清脆林间鸟鸣" },
  { key: "epic_strings", label: "恢弘电影弦乐铺底", directive: "低沉大提琴与宽广电影弦乐渐强铺底" },
  { key: "lofi_beat", label: "轻快现代电子节拍", directive: "轻快律动合成器节奏与细腻都市电子氛围音" },
  { key: "quiet_room", label: "静谧室内空间环境音", directive: "安静室内空气质感底噪，轻微咖啡杯与衣物摩擦声" },
] as const;

/** 合成符合 Google Flow Veo / Omni 音画同步标准的【声画指令】片段。 */
export function composeAudioDirective(opts: {
  voiceKey?: string;
  dialogue?: string;
  sfx?: string;
  ambienceKey?: string;
}): string {
  const voice = VOICE_PRESETS.find((v) => v.key === opts.voiceKey);
  const ambience = AMBIENCE_PRESETS.find((a) => a.key === opts.ambienceKey);
  const dialogue = opts.dialogue?.trim() ?? "";
  const sfx = opts.sfx?.trim() ?? "";

  const parts: string[] = [];
  if (dialogue) {
    const toneDesc = voice ? `${voice.label}，${voice.directive}` : "自然人声对白";
    parts.push(`角色台词（${toneDesc}，口型自然同步）：“${dialogue}”`);
  } else if (voice) {
    parts.push(`画外旁白风格：${voice.directive}`);
  }
  if (sfx) {
    parts.push(`动作音效：${sfx}`);
  }
  if (ambience) {
    parts.push(`环境氛围音：${ambience.directive}`);
  }

  if (parts.length === 0) return "";
  return `【声画指令】${parts.join("；")}`;
}

export interface TimelineShotOverride {
  excluded?: boolean;
  imageDurationSec?: number;
}

export interface OrderedTimelineEntry<T extends { key: string }> {
  shot: T;
  excluded: boolean;
  imageDurationSec: number;
}

/** 按自定义顺序与单镜覆写解析时间线播放及成片导出队列。 */
export function resolveOrderedTimelineShots<T extends { key: string }>(
  rawShots: readonly T[],
  customOrderKeys: readonly string[],
  shotOverrides: Record<string, TimelineShotOverride>,
  defaultImageDurationSec = 3,
): OrderedTimelineEntry<T>[] {
  const byKey = new Map<string, T>();
  for (const s of rawShots) {
    byKey.set(s.key, s);
  }

  const ordered: T[] = [];
  const placed = new Set<string>();
  for (const k of customOrderKeys) {
    const found = byKey.get(k);
    if (found && !placed.has(k)) {
      ordered.push(found);
      placed.add(k);
    }
  }
  for (const s of rawShots) {
    if (!placed.has(s.key)) {
      ordered.push(s);
      placed.add(s.key);
    }
  }

  return ordered.map((shot) => {
    const ov = shotOverrides[shot.key];
    return {
      shot,
      excluded: Boolean(ov?.excluded),
      imageDurationSec:
        typeof ov?.imageDurationSec === "number" && ov.imageDurationSec > 0
          ? ov.imageDurationSec
          : defaultImageDurationSec,
    };
  });
}

const BGM_STORAGE_KEY = "flowboard.timelineBgm.v1";

interface PersistedBgm {
  mediaId: string | null;
  name: string;
  url: string;
  volume?: number;
}

function loadPersistedBgm(): PersistedBgm | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(BGM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedBgm>;
    if (typeof parsed.url === "string" && parsed.url && !parsed.url.startsWith("blob:")) {
      return {
        mediaId: typeof parsed.mediaId === "string" ? parsed.mediaId : null,
        name: typeof parsed.name === "string" && parsed.name ? parsed.name : "画布配乐轨",
        url: parsed.url,
        volume: typeof parsed.volume === "number" ? parsed.volume : undefined,
      };
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function persistBgm(entry: PersistedBgm | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!entry || entry.url.startsWith("blob:")) {
      localStorage.removeItem(BGM_STORAGE_KEY);
    } else {
      localStorage.setItem(BGM_STORAGE_KEY, JSON.stringify(entry));
    }
  } catch {
    // non-fatal
  }
}

interface TimelineAudioState {
  bgmName: string | null;
  bgmUrl: string | null;
  bgmMediaId: string | null;
  bgmVolume: number;
  bgmFadeOutSec: number;
  videoAudioMuted: boolean;
  shotOverrides: Record<string, TimelineShotOverride>;
  customOrderKeys: string[];

  setBgmFile(file: File | null): void;
  setBgmMediaAsset(asset: { mediaId: string; name: string; url: string } | null): void;
  setBgmVolume(volume: number): void;
  setBgmFadeOutSec(sec: number): void;
  setVideoAudioMuted(muted: boolean): void;
  toggleShotExcluded(key: string): void;
  setShotImageDuration(key: string, sec: number): void;
  moveShotKey(orderedKeys: string[], index: number, delta: -1 | 1): void;
  resetTimelineOverrides(): void;
}

const initialBgm = loadPersistedBgm();

export const useTimelineAudioStore = create<TimelineAudioState>((set, get) => ({
  bgmName: initialBgm?.name ?? null,
  bgmUrl: initialBgm?.url ?? null,
  bgmMediaId: initialBgm?.mediaId ?? null,
  bgmVolume: initialBgm?.volume ?? 0.65,
  bgmFadeOutSec: 2,
  videoAudioMuted: false,
  shotOverrides: {},
  customOrderKeys: [],

  setBgmFile(file) {
    const prevUrl = get().bgmUrl;
    if (prevUrl && prevUrl.startsWith("blob:") && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try {
        URL.revokeObjectURL(prevUrl);
      } catch {
        // non-fatal
      }
    }
    if (!file) {
      persistBgm(null);
      set({ bgmName: null, bgmUrl: null, bgmMediaId: null });
      return;
    }
    const nextUrl =
      typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : null;
    persistBgm(null);
    set({ bgmName: file.name, bgmUrl: nextUrl, bgmMediaId: null });
  },

  setBgmMediaAsset(asset) {
    const prevUrl = get().bgmUrl;
    if (prevUrl && prevUrl.startsWith("blob:") && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try {
        URL.revokeObjectURL(prevUrl);
      } catch {
        // non-fatal
      }
    }
    if (!asset) {
      persistBgm(null);
      set({ bgmName: null, bgmUrl: null, bgmMediaId: null });
      return;
    }
    persistBgm({
      mediaId: asset.mediaId,
      name: asset.name,
      url: asset.url,
      volume: get().bgmVolume,
    });
    set({
      bgmName: asset.name,
      bgmUrl: asset.url,
      bgmMediaId: asset.mediaId,
    });
  },

  setBgmVolume(volume) {
    const clamped = Math.max(0, Math.min(1, volume));
    const cur = get();
    if (cur.bgmUrl && !cur.bgmUrl.startsWith("blob:") && cur.bgmName) {
      persistBgm({
        mediaId: cur.bgmMediaId,
        name: cur.bgmName,
        url: cur.bgmUrl,
        volume: clamped,
      });
    }
    set({ bgmVolume: clamped });
  },

  setBgmFadeOutSec(sec) {
    set({ bgmFadeOutSec: Math.max(0, Math.min(6, Number(sec) || 0)) });
  },

  setVideoAudioMuted(muted) {
    set({ videoAudioMuted: muted });
  },

  toggleShotExcluded(key) {
    set((s) => {
      const cur = s.shotOverrides[key] ?? {};
      return {
        shotOverrides: {
          ...s.shotOverrides,
          [key]: { ...cur, excluded: !cur.excluded },
        },
      };
    });
  },

  setShotImageDuration(key, sec) {
    const safeSec = Math.max(1, Math.min(15, Math.round(sec)));
    set((s) => {
      const cur = s.shotOverrides[key] ?? {};
      return {
        shotOverrides: {
          ...s.shotOverrides,
          [key]: { ...cur, imageDurationSec: safeSec },
        },
      };
    });
  },

  moveShotKey(orderedKeys, index, delta) {
    const nextIdx = index + delta;
    if (index < 0 || nextIdx < 0 || index >= orderedKeys.length || nextIdx >= orderedKeys.length) {
      return;
    }
    const copy = [...orderedKeys];
    const [item] = copy.splice(index, 1);
    copy.splice(nextIdx, 0, item);
    set({ customOrderKeys: copy });
  },

  resetTimelineOverrides() {
    set({ shotOverrides: {}, customOrderKeys: [] });
  },
}));
