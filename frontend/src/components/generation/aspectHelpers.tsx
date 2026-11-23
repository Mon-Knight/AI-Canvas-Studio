import { useBoardStore } from "../../store/board";
import { VIDEO_CAMERA_PRESETS } from "../../lib/promptMentions";
import {
  IMAGE_ASPECT_OPTIONS,
  VIDEO_ASPECT_OPTIONS,
} from "../../constants/models";

export const PROMPT_MAX_LENGTH = 2000;

export const IMAGE_ASPECT_RATIOS = IMAGE_ASPECT_OPTIONS.map((a) => ({
  key: a.value,
  label: a.shortLabel,
  fullLabel: a.label,
}));

export const VIDEO_ASPECT_RATIOS = VIDEO_ASPECT_OPTIONS.map((a) => ({
  key: a.value,
  label: a.label,
  shortLabel: a.shortLabel,
}));

export const CAMERA_MOVEMENTS = VIDEO_CAMERA_PRESETS;
export type CameraKey = string;

export type ImageAspectKey = (typeof IMAGE_ASPECT_OPTIONS)[number]["value"];
export type VideoAspectKey = (typeof VIDEO_ASPECT_OPTIONS)[number]["value"];
export type AspectKey = ImageAspectKey | VideoAspectKey;

export function imageAspectToVideo(
  img: string | undefined,
): VideoAspectKey | null {
  if (
    img === "VIDEO_ASPECT_RATIO_LANDSCAPE" ||
    img === "VIDEO_ASPECT_RATIO_PORTRAIT"
  ) {
    return img;
  }
  if (
    img === "IMAGE_ASPECT_RATIO_LANDSCAPE" ||
    img === "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE"
  ) {
    return "VIDEO_ASPECT_RATIO_LANDSCAPE";
  }
  if (
    img === "IMAGE_ASPECT_RATIO_PORTRAIT" ||
    img === "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR" ||
    img === "IMAGE_ASPECT_RATIO_SQUARE"
  ) {
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  return null;
}

export function videoAspectToImage(ar: string): ImageAspectKey | null {
  if (ar === "VIDEO_ASPECT_RATIO_LANDSCAPE")
    return "IMAGE_ASPECT_RATIO_LANDSCAPE";
  if (ar === "VIDEO_ASPECT_RATIO_PORTRAIT")
    return "IMAGE_ASPECT_RATIO_PORTRAIT";
  return IMAGE_ASPECT_RATIOS.some((p) => p.key === ar)
    ? (ar as ImageAspectKey)
    : null;
}

export function pickDefaultAspect(
  rfId: string,
  targetType: string,
  nodes: ReturnType<typeof useBoardStore.getState>["nodes"],
  edges: ReturnType<typeof useBoardStore.getState>["edges"],
): AspectKey | null {
  const upstreamAspects: string[] = [];
  for (const e of edges) {
    if (e.target !== rfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    const ar = src.data.aspectRatio;
    if (typeof ar === "string" && ar.length > 0) upstreamAspects.push(ar);
  }
  if (upstreamAspects.length === 0) return null;

  if (targetType === "video") {
    const mapped = upstreamAspects
      .map(imageAspectToVideo)
      .filter((x): x is VideoAspectKey => x !== null);
    if (mapped.length === 0) return null;
    const unique = new Set(mapped);
    if (unique.size === 1) return mapped[0];
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  const validImg = upstreamAspects
    .map(videoAspectToImage)
    .filter((a): a is ImageAspectKey => a !== null);
  if (validImg.length === 0) return null;
  const unique = new Set(validImg);
  if (unique.size === 1) return validImg[0];
  return "IMAGE_ASPECT_RATIO_PORTRAIT";
}

export function InfoTip({ tip }: { tip: string }) {
  return (
    <span
      className="gen-dialog__info-tip"
      title={tip}
      aria-label={tip}
      role="img"
    >
      ⓘ
    </span>
  );
}
