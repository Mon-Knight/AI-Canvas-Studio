import { create } from "zustand";

/**
 * Per-user model preferences. Survives page reload via localStorage —
 * single-user, single-host app, so no need for server persistence.
 *
 * Image model: Flow ships two checkpoints — "NANO_BANANA_PRO" (premium,
 * higher quality, slower) and "NANO_BANANA_2" (faster, lighter). Users
 * pick once in the dashboard Settings panel; every gen_image / edit_image
 * dispatch reads the cached preference and forwards it to the worker.
 *
 * Video model is currently derived from paygate tier + aspect (resolved
 * server-side via VIDEO_MODEL_KEYS), so it's a *display* on the panel
 * rather than a switchable preference. When/if Flow ships variants per
 * tier (e.g. fast vs quality) we extend this store with `videoModelKey`.
 */
export type ImageModelKey =
  | "NANO_BANANA_PRO"
  | "NANO_BANANA_2_1"
  | "NANO_BANANA_2_LITE"
  | "NANO_BANANA_2";

export type ImageThinkingLevel = "default" | "low" | "medium" | "high";
export type ImageResolutionKey = "1K" | "2K" | "4K";
export type VideoResolutionKey = "360p" | "720p" | "1080p" | "4k";
export type OmniFlashVersion = "1.1" | "1.2";
export type OutputCountOption = 1 | 2 | 3 | 4;
// Veo 3.1 ships in four flavours:
//   - Lite (smaller checkpoint, fastest, lower fidelity)
//   - Fast (default — bigger model, balanced)
//   - Quality (highest fidelity, slowest)
//   - Lite Relaxed (Lite on a low-priority queue, 0 credits — Ultra only)
// Choice applies globally across both portrait and landscape; backend
// resolves the actual model key at dispatch time from [tier][quality][aspect].
// Tier 1 (Pro) users picking `lite_relaxed` fall back to Fast on the
// backend (and the Settings UI locks that radio for them).
export type VideoQuality =
  | "fast"
  | "lite"
  | "quality"
  | "lite_relaxed";

// Video model family. "veo" = the existing Veo 3.1 i2v family controlled
// by videoQuality (lite/fast/quality/...). "omni_flash" = the new
// reference-image r2v model with per-duration credit cost and no
// per-tier quality variants — duration is picked per dispatch in the
// GenerationDialog. The video dispatch path branches on this.
export type VideoModelFamily = "veo" | "omni_flash";

// Omni Flash duration → credit cost (informational, surfaced in the
// dialog so the user sees the cost before submit). Mirrors the backend
// OMNI_FLASH_CREDIT_COST table — pin both via tests.
// Omni 1.1 legacy fixed costs (4/6/8/10s) and Omni 1.2 variable durations (3..15s).
export const OMNI_FLASH_CREDIT_COST: Record<number, number> = {
  4: 15,
  6: 20,
  8: 25,
  10: 30,
};
export type OmniFlashDuration = number;
export const OMNI_FLASH_DURATIONS: readonly number[] = [4, 6, 8, 10];
export const OMNI_1_2_DURATIONS: readonly number[] = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

// Generation backend. "flow" = the existing Chrome-extension → Google
// Flow path. "muse" = delegated to a Pax worker via the provider-job
// queue (no Flow plan, no extension needed). Picked per dispatch in the
// GenerationDialog and sticky — persisted here like the model picks.
export type MediaProviderKey = "flow" | "muse";
export type VideoConfirmMode = "always" | "never";

interface SettingsState {
  imageModel: ImageModelKey;
  imageResolution: ImageResolutionKey;
  imageThinkingLevel: ImageThinkingLevel;
  defaultImageAspect: string;
  defaultImageCount: OutputCountOption;
  videoQuality: VideoQuality;
  videoModel: VideoModelFamily;
  omniVersion: OmniFlashVersion;
  omniFlashDuration: OmniFlashDuration;
  videoResolution: VideoResolutionKey;
  defaultVideoAspect: string;
  defaultVideoCount: OutputCountOption;
  mediaProvider: MediaProviderKey;
  confirmBeforeVideoGen: VideoConfirmMode;
  setImageModel(model: ImageModelKey): void;
  setImageResolution(res: ImageResolutionKey): void;
  setImageThinkingLevel(level: ImageThinkingLevel): void;
  setDefaultImageAspect(aspect: string): void;
  setDefaultImageCount(count: OutputCountOption): void;
  setVideoQuality(q: VideoQuality): void;
  setVideoModel(m: VideoModelFamily): void;
  setOmniVersion(v: OmniFlashVersion): void;
  setOmniFlashDuration(d: OmniFlashDuration): void;
  setVideoResolution(res: VideoResolutionKey): void;
  setDefaultVideoAspect(aspect: string): void;
  setDefaultVideoCount(count: OutputCountOption): void;
  setMediaProvider(p: MediaProviderKey): void;
  setConfirmBeforeVideoGen(mode: VideoConfirmMode): void;
}

const STORAGE_KEY = "flowboard.settings.v1";

interface PersistShape {
  imageModel?: ImageModelKey;
  imageResolution?: ImageResolutionKey;
  imageThinkingLevel?: ImageThinkingLevel;
  defaultImageAspect?: string;
  defaultImageCount?: OutputCountOption;
  videoQuality?: VideoQuality;
  videoModel?: VideoModelFamily;
  omniVersion?: OmniFlashVersion;
  omniFlashDuration?: OmniFlashDuration;
  videoResolution?: VideoResolutionKey;
  defaultVideoAspect?: string;
  defaultVideoCount?: OutputCountOption;
  mediaProvider?: MediaProviderKey;
  confirmBeforeVideoGen?: VideoConfirmMode;
}

function loadPersisted(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function persist(state: PersistShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled / quota — non-fatal, just lose persistence.
  }
}

const persisted = loadPersisted();

const VALID_IMAGE_MODELS: ImageModelKey[] = [
  "NANO_BANANA_PRO",
  "NANO_BANANA_2_1",
  "NANO_BANANA_2_LITE",
  "NANO_BANANA_2",
];
const VALID_IMAGE_RESOLUTIONS: ImageResolutionKey[] = ["1K", "2K", "4K"];
const VALID_THINKING_LEVELS: ImageThinkingLevel[] = ["default", "low", "medium", "high"];
const VALID_VIDEO_QUALITIES: VideoQuality[] = ["fast", "lite", "quality", "lite_relaxed"];
const VALID_VIDEO_RESOLUTIONS: VideoResolutionKey[] = ["360p", "720p", "1080p", "4k"];
const VALID_OMNI_VERSIONS: OmniFlashVersion[] = ["1.1", "1.2"];
const VALID_MEDIA_PROVIDERS: MediaProviderKey[] = ["flow", "muse"];
const VALID_VIDEO_CONFIRM_MODES: VideoConfirmMode[] = ["always", "never"];

function snapshotPersist(get: () => SettingsState): PersistShape {
  return {
    imageModel: get().imageModel,
    imageResolution: get().imageResolution,
    imageThinkingLevel: get().imageThinkingLevel,
    defaultImageAspect: get().defaultImageAspect,
    defaultImageCount: get().defaultImageCount,
    videoQuality: get().videoQuality,
    videoModel: get().videoModel,
    omniVersion: get().omniVersion,
    omniFlashDuration: get().omniFlashDuration,
    videoResolution: get().videoResolution,
    defaultVideoAspect: get().defaultVideoAspect,
    defaultVideoCount: get().defaultVideoCount,
    mediaProvider: get().mediaProvider,
    confirmBeforeVideoGen: get().confirmBeforeVideoGen,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  imageModel:
    persisted.imageModel && VALID_IMAGE_MODELS.includes(persisted.imageModel)
      ? persisted.imageModel
      : "NANO_BANANA_PRO",
  imageResolution:
    persisted.imageResolution && VALID_IMAGE_RESOLUTIONS.includes(persisted.imageResolution)
      ? persisted.imageResolution
      : "1K",
  imageThinkingLevel:
    persisted.imageThinkingLevel && VALID_THINKING_LEVELS.includes(persisted.imageThinkingLevel)
      ? persisted.imageThinkingLevel
      : "default",
  defaultImageAspect:
    typeof persisted.defaultImageAspect === "string" && persisted.defaultImageAspect
      ? persisted.defaultImageAspect
      : "IMAGE_ASPECT_RATIO_LANDSCAPE",
  defaultImageCount:
    persisted.defaultImageCount && [1, 2, 3, 4].includes(persisted.defaultImageCount)
      ? persisted.defaultImageCount
      : 1,
  videoQuality:
    persisted.videoQuality && VALID_VIDEO_QUALITIES.includes(persisted.videoQuality)
      ? persisted.videoQuality
      : "lite",
  videoModel: persisted.videoModel ?? "veo",
  omniVersion:
    persisted.omniVersion && VALID_OMNI_VERSIONS.includes(persisted.omniVersion)
      ? persisted.omniVersion
      : "1.2",
  omniFlashDuration:
    typeof persisted.omniFlashDuration === "number" &&
    persisted.omniFlashDuration >= 3 &&
    persisted.omniFlashDuration <= 15
      ? persisted.omniFlashDuration
      : 4,
  videoResolution:
    persisted.videoResolution && VALID_VIDEO_RESOLUTIONS.includes(persisted.videoResolution)
      ? persisted.videoResolution
      : "720p",
  defaultVideoAspect:
    typeof persisted.defaultVideoAspect === "string" && persisted.defaultVideoAspect
      ? persisted.defaultVideoAspect
      : "VIDEO_ASPECT_RATIO_LANDSCAPE",
  defaultVideoCount:
    persisted.defaultVideoCount && [1, 2, 3, 4].includes(persisted.defaultVideoCount)
      ? persisted.defaultVideoCount
      : 1,
  mediaProvider:
    persisted.mediaProvider && VALID_MEDIA_PROVIDERS.includes(persisted.mediaProvider)
      ? persisted.mediaProvider
      : "flow",
  confirmBeforeVideoGen:
    persisted.confirmBeforeVideoGen &&
    VALID_VIDEO_CONFIRM_MODES.includes(persisted.confirmBeforeVideoGen)
      ? persisted.confirmBeforeVideoGen
      : "always",
  setImageModel(model) {
    set({ imageModel: model });
    persist(snapshotPersist(get));
  },
  setImageResolution(res) {
    set({ imageResolution: res });
    persist(snapshotPersist(get));
  },
  setImageThinkingLevel(level) {
    set({ imageThinkingLevel: level });
    persist(snapshotPersist(get));
  },
  setDefaultImageAspect(aspect) {
    set({ defaultImageAspect: aspect });
    persist(snapshotPersist(get));
  },
  setDefaultImageCount(count) {
    set({ defaultImageCount: count });
    persist(snapshotPersist(get));
  },
  setVideoQuality(q) {
    set({ videoQuality: q });
    persist(snapshotPersist(get));
  },
  setVideoModel(m) {
    set({ videoModel: m });
    persist(snapshotPersist(get));
  },
  setOmniVersion(v) {
    const current = get().omniFlashDuration;
    const nextDuration = v === "1.1" && ![4, 6, 8, 10].includes(current) ? 4 : current;
    set({ omniVersion: v, omniFlashDuration: nextDuration });
    persist(snapshotPersist(get));
  },
  setOmniFlashDuration(d) {
    set({ omniFlashDuration: d });
    persist(snapshotPersist(get));
  },
  setVideoResolution(res) {
    set({ videoResolution: res });
    persist(snapshotPersist(get));
  },
  setDefaultVideoAspect(aspect) {
    set({ defaultVideoAspect: aspect });
    persist(snapshotPersist(get));
  },
  setDefaultVideoCount(count) {
    set({ defaultVideoCount: count });
    persist(snapshotPersist(get));
  },
  setMediaProvider(p) {
    set({ mediaProvider: p });
    persist(snapshotPersist(get));
  },
  setConfirmBeforeVideoGen(mode) {
    set({ confirmBeforeVideoGen: mode });
    persist(snapshotPersist(get));
  },
}));
