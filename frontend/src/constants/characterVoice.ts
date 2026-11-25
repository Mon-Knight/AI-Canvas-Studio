import type { Edge } from "@xyflow/react";
import type { FlowboardEdgeData, FlowNode } from "../store/board";
import { displayNodeTitle } from "./nodeLabels";

export interface CharacterVoicePreset {
  key: string;
  label: string;
  shortLabel: string;
  category: "female" | "male" | "special";
  directive: string;
}

export const CHARACTER_VOICE_PRESETS: readonly CharacterVoicePreset[] = [
  {
    key: "warm_female",
    label: "温柔治愈女声",
    shortLabel: "温柔女声",
    category: "female",
    directive: "温柔治愈女声，音色温润清甜、语速舒缓自然、富有亲和力",
  },
  {
    key: "bright_girl",
    label: "清亮元气少女",
    shortLabel: "元气少女",
    category: "female",
    directive: "清亮元气少女音，咬字灵动明快、活力充沛、青春感鲜明",
  },
  {
    key: "cold_royal_female",
    label: "清冷御姐女声",
    shortLabel: "清冷御姐",
    category: "female",
    directive: "清冷御姐女声，声线沉稳利落、低微磁性、克制有气场",
  },
  {
    key: "deep_cinema_male",
    label: "电影深沉男声",
    shortLabel: "深沉男声",
    category: "male",
    directive: "电影深沉男声，低沉磁性、胸腔共鸣扎实、情绪克制有张力",
  },
  {
    key: "sunny_youth_male",
    label: "清朗少年男声",
    shortLabel: "清朗少年",
    category: "male",
    directive: "清朗青年少年男声，嗓音干净明亮、自然松弛、有朝气",
  },
  {
    key: "mature_uncle_male",
    label: "醇厚磁性熟男",
    shortLabel: "磁性熟男",
    category: "male",
    directive: "醇厚磁性中年男声，低音细腻稳重、富有叙事沧桑感",
  },
  {
    key: "cute_child",
    label: "灵动童声萌音",
    shortLabel: "灵动童声",
    category: "special",
    directive: "软萌清脆童声，天真活泼、语调上扬灵动、清澈纯净",
  },
  {
    key: "ancient_heroic",
    label: "古风侠气声线",
    shortLabel: "古风侠气",
    category: "special",
    directive: "古风韵味声线，吐字铿锵从容、气韵悠长、戏剧表现力强",
  },
  {
    key: "suspense_whisper",
    label: "悬疑低语声线",
    shortLabel: "悬疑低语",
    category: "special",
    directive: "悬疑贴耳低沉气声，节奏紧凑微颤、近距离呼吸感强",
  },
  {
    key: "custom",
    label: "自定义音色描述",
    shortLabel: "自定义音色",
    category: "special",
    directive: "",
  },
] as const;

export const CHARACTER_VOICE_PRESET_MAP: Readonly<Record<string, CharacterVoicePreset>> =
  Object.fromEntries(CHARACTER_VOICE_PRESETS.map((p) => [p.key, p]));

export interface BoundCharacterVoice {
  rfId: string;
  shortId: string;
  title: string;
  label: string;
  directive: string;
}

/**
 * Compact display label for a character's bound fixed voice.
 * Returns `null` when no voice is bound.
 */
export function resolveCharacterVoiceLabel(
  voicePreset?: string | null,
  voiceCustom?: string | null,
): string | null {
  const presetKey = (voicePreset ?? "").trim();
  const custom = (voiceCustom ?? "").trim();
  if (!presetKey && !custom) return null;
  if (presetKey && presetKey !== "custom") {
    const found = CHARACTER_VOICE_PRESET_MAP[presetKey];
    if (found) return found.label;
  }
  if (custom) {
    return custom.length > 12 ? `${custom.slice(0, 12)}…` : custom;
  }
  return null;
}

/**
 * Full Simplified Chinese voice trait directive describing a character's fixed timbre.
 */
export function resolveCharacterVoiceDirective(
  voicePreset?: string | null,
  voiceCustom?: string | null,
): string {
  const presetKey = (voicePreset ?? "").trim();
  const custom = (voiceCustom ?? "").trim();
  const preset = presetKey && presetKey !== "custom" ? CHARACTER_VOICE_PRESET_MAP[presetKey] : undefined;
  if (preset && custom) {
    return `${preset.directive}，补充声线特征：${custom}`;
  }
  if (preset) {
    return preset.directive;
  }
  if (custom) {
    return custom;
  }
  return "";
}

const VOICE_TRAVERSABLE_TYPES = new Set([
  "image",
  "prompt",
  "note",
  "Storyboard",
  "visual_asset",
  "video",
  "merge",
]);

/**
 * Walk upstream from a target node (typically a `video` node) up to 4 hops to
 * discover all connected `character` nodes that have a fixed voice bound.
 * Supports both direct (`character -> video`) and chained
 * (`character -> image -> video`, `character -> image -> prompt -> video`) graphs.
 */
export function collectUpstreamCharacterVoices(
  targetRfId: string,
  nodes: readonly FlowNode[],
  edges: readonly Edge<FlowboardEdgeData>[],
  maxDepth = 4,
): BoundCharacterVoice[] {
  const nodeById = new Map<string, FlowNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  const visited = new Set<string>([targetRfId]);
  const seenChar = new Set<string>();
  const out: BoundCharacterVoice[] = [];

  const walk = (currId: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const edge of edges) {
      if (edge.target !== currId) continue;
      const src = nodeById.get(edge.source);
      if (!src) continue;

      if (src.data.type === "character" && !seenChar.has(src.id)) {
        const directive = resolveCharacterVoiceDirective(
          src.data.voicePreset,
          src.data.voiceCustom,
        );
        const label = resolveCharacterVoiceLabel(
          src.data.voicePreset,
          src.data.voiceCustom,
        );
        if (directive && label) {
          seenChar.add(src.id);
          out.push({
            rfId: src.id,
            shortId: src.data.shortId,
            title: displayNodeTitle(src.data.title, "character"),
            label,
            directive,
          });
        }
      }

      if (!visited.has(src.id) && VOICE_TRAVERSABLE_TYPES.has(src.data.type)) {
        visited.add(src.id);
        walk(src.id, depth + 1);
      }
    }
  };

  walk(targetRfId, 1);
  return out;
}

/**
 * Format bound character voices into a Flow/Veo-compatible Chinese voice-consistency clause.
 */
export function formatCharacterVoicesDirective(
  voices: readonly Pick<BoundCharacterVoice, "title" | "directive">[],
  hasExplicitDialogue = false,
): string {
  const valid = voices.filter((v) => v.directive.trim().length > 0);
  if (valid.length === 0) return "";
  const joined = valid
    .map((v) => `${v.title}（${v.directive.trim()}）`)
    .join("；");
  if (hasExplicitDialogue) {
    return `角色固定音色严格保持：${joined}`;
  }
  return `角色固定音色绑定（若画面出现该角色开口台词或发声，须保持以下固定声线）：${joined}`;
}
