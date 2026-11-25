/**
 * 提示词 `@图N` 参考图标签规范化 + 视频运镜预设词典。
 * 保持纯 TS 零 DOM 依赖，供 GenerationDialog、generation.ts 与单元测试复用。
 */

export interface VideoCameraPreset {
  key: string;
  label: string;
  instruction: string;
}

export const VIDEO_CAMERA_PRESETS: readonly VideoCameraPreset[] = [
  {
    key: "static",
    label: "固定机位",
    instruction:
      "机位约束：固定三脚架静止机位，严禁推拉缩放或摇移镜头。全程保持人物或核心主体完整居中清晰入画，背景边界与裁切构图保持恒定。",
  },
  {
    key: "dynamic",
    label: "智能动态",
    instruction: "",
  },
  {
    key: "dolly_in",
    label: "缓慢推近",
    instruction: "运镜方式：电影轨道缓慢向前推近主体（Slow Dolly In），焦平面平滑聚焦情绪张力。",
  },
  {
    key: "pull_out",
    label: "拉远全景",
    instruction: "运镜方式：镜头平稳向后拉远（Slow Pull Out），逐步揭示宏阔环境与人物空间关系。",
  },
  {
    key: "orbit",
    label: "环绕跟拍",
    instruction: "运镜方式：电影级环绕轨迹平稳跟拍（Smooth Orbit Tracking Shot），展现立体光影与空间层次。",
  },
  {
    key: "handheld",
    label: "手持纪实",
    instruction: "运镜方式：细腻克制的手持呼吸感跟拍（Subtle Handheld Documentary），增强现场临场感。",
  },
  {
    key: "crane_tilt",
    label: "摇臂俯仰",
    instruction: "运镜方式：电影升降摇臂缓缓抬升配合柔和俯仰扫景（Cinematic Crane Tilt），营造史诗纵深感。",
  },
] as const;

export function videoCameraInstruction(key: string): string {
  return VIDEO_CAMERA_PRESETS.find((c) => c.key === key)?.instruction ?? "";
}

/**
 * 将用户输入的 `@图1`、`@图 2`、`@1` 等引用标记规整化为 Flow 底层参考图标识 `ref_image_N`，
 * 便于多参考生图与 Omni 多图生视频准确对齐主体角色与物品。
 */
export function normalizePromptRefMentions(prompt: string, refCount = 9): string {
  const maxIdx = Math.max(1, Math.min(9, refCount || 9));
  return prompt.replace(/(^|[\s，。、“"'‘（(【\[])@(?:图\s*)?([1-9])(?!\d)/g, (full, prefix: string, digit: string) => {
    const idx = Number(digit);
    if (idx < 1 || idx > maxIdx) return full;
    return `${prefix}ref_image_${idx}`;
  });
}

export const SILENT_VIDEO_DIRECTIVE =
  "静音视频约束：全程完全静音无声，严禁生成任何人物对话、旁白、口型发声、背景音乐或环境音效，人物保持自然闭口状态，纯无声纯视觉画面（complete silence, muted audio, no speech, no music, no sound effects）";

export interface VideoPromptCharacterVoice {
  title: string;
  directive: string;
}

export function composeVideoPromptWithDirectives(opts: {
  prompt: string;
  cameraKey: string;
  dialogue?: string;
  sfx?: string;
  silentVideo?: boolean;
  characterVoices?: readonly VideoPromptCharacterVoice[];
}): string {
  const parts: string[] = [];
  let main = opts.prompt.trim();
  if (opts.silentVideo && main) {
    // Strip any previously written 【声画指令】 snippet so it never contradicts silent mode
    main = main.replace(/\n*【声画指令】[^\n]*/g, "").trim();
  }
  if (main) parts.push(main);
  const cam = videoCameraInstruction(opts.cameraKey);
  if (cam) parts.push(cam);

  if (opts.silentVideo) {
    parts.push(SILENT_VIDEO_DIRECTIVE);
    return parts.join("；");
  }

  const validVoices = (opts.characterVoices ?? []).filter(
    (v) => v.directive.trim().length > 0,
  );
  const dlg = (opts.dialogue ?? "").trim();
  if (dlg) {
    if (validVoices.length > 0) {
      const voiceSummary = validVoices
        .map((v) => `${v.title}·${v.directive.trim()}`)
        .join("；");
      parts.push(
        `人物台词对白（严格保持绑定固定音色：${voiceSummary}，口型与声调自然同步）：“${dlg}”`,
      );
    } else {
      parts.push(`人物台词对白（口型与声调自然同步）：“${dlg}”`);
    }
  } else if (validVoices.length > 0) {
    const voiceSummary = validVoices
      .map((v) => `${v.title}（${v.directive.trim()}）`)
      .join("；");
    parts.push(
      `角色固定音色绑定（若镜头中出现该角色开口台词或发声，须保持固定声线）：${voiceSummary}`,
    );
  }
  const sfx = (opts.sfx ?? "").trim();
  if (sfx) parts.push(`环境音与音效设计：${sfx}`);
  return parts.join("；");
}
