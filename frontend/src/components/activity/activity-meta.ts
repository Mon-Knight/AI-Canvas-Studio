export const ACTIVITY_TYPE_META: Record<
  string,
  { label: string; group: "llm" | "gen" | "upload" }
> = {
  auto_prompt:       { label: "智能提示词合成",     group: "llm" },
  auto_prompt_batch: { label: "批量提示词合成",     group: "llm" },
  vision:            { label: "画面视觉解析",       group: "llm" },
  planner:           { label: "画布分镜规划",       group: "llm" },
  chat_agent:        { label: "AI 对话编排",        group: "llm" },
  gen_image:         { label: "生成图片",           group: "gen" },
  gen_video:         { label: "生成视频",           group: "gen" },
  gen_video_omni:    { label: "多参考视频生成",     group: "gen" },
  edit_image:        { label: "图像局部精修",       group: "gen" },
  gen_music:         { label: "AI 音乐生成",        group: "gen" },
  edit_music:        { label: "AI 音乐衍生编辑",    group: "gen" },
  split_stems:       { label: "四轨分轨 (0积分)",   group: "gen" },
  effect_music:      { label: "音频裁剪变速 (0积分)", group: "gen" },
  upload:            { label: "本地文件上传",       group: "upload" },
  upload_url:        { label: "网络链接导入",       group: "upload" },
};

export function metaFor(type: string) {
  return (
    ACTIVITY_TYPE_META[type] ?? { label: type, group: "llm" as const }
  );
}

export const STATUS_META: Record<
  string,
  { icon: string; label: string; tone: "muted" | "running" | "ok" | "fail" }
> = {
  queued:   { icon: "⋯", label: "排队中", tone: "muted" },
  running:  { icon: "⟳", label: "运行中", tone: "running" },
  done:     { icon: "✓", label: "已完成", tone: "ok" },
  failed:   { icon: "✗", label: "失败",   tone: "fail" },
  canceled: { icon: "⊘", label: "已取消", tone: "muted" },
  timeout:  { icon: "⏱", label: "超时",   tone: "fail" },
};

export function statusMeta(status: string) {
  return STATUS_META[status] ?? { icon: "•", label: status, tone: "muted" as const };
}

export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return "刚刚";
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${min}分${s}秒`;
}
