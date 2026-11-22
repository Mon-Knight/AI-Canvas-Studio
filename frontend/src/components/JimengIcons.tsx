import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** 即梦风格彩色流光棱镜徽标（用于左上角品牌区与画布空状态引导） */
export function JimengPrismLogo({ size = 22, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      {...rest}
    >
      <defs>
        <linearGradient id="jm-prism-a" x1="2" y1="3" x2="22" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="52%" stopColor="#2563eb" />
          <stop offset="100%" stopColor="#60a5fa" />
        </linearGradient>
        <linearGradient id="jm-prism-b" x1="4" y1="4" x2="17" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fde047" />
          <stop offset="55%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <path
        d="M4.6 3.9c-.8-.45-1.75.25-1.56 1.15l3.15 14.7c.18.85 1.18 1.2 1.84.63l12.4-10.6c.68-.58.52-1.68-.28-2.05L4.6 3.9Z"
        fill="url(#jm-prism-a)"
      />
      <path
        d="M4.6 3.9l8.6 7.85 7.13-4.02L4.6 3.9Z"
        fill="url(#jm-prism-b)"
        opacity="0.9"
      />
      <path
        d="M3.9 4.5l9.3 7.25-5.15 7.45"
        stroke="rgba(255,255,255,0.65)"
        strokeWidth="0.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 文本节点图标 (T) */
export function IconText({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M4.5 5.5V4h11v1.5" />
      <path d="M10 4v12" />
      <path d="M7.5 16h5" />
    </svg>
  );
}

/** 图片节点图标 */
export function IconImage({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <rect x="3" y="3.5" width="14" height="13" rx="2.6" />
      <circle cx="7.3" cy="7.8" r="1.25" />
      <path d="M3.5 14l4.1-3.8a1.2 1.2 0 0 1 1.65.02L12.5 13.5l2.1-1.9a1.1 1.1 0 0 1 1.5.04L17 12.5" />
    </svg>
  );
}

/** 视频节点图标 */
export function IconVideo({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <rect x="3" y="3.5" width="14" height="13" rx="2.6" />
      <path d="M8.5 7.6l4.4 2.4-4.4 2.4V7.6Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 主体（角色/物品锚点）图标 */
export function IconSubject({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3" />
      <circle cx="10" cy="8.2" r="2.1" />
      <path d="M6.3 14.3c.7-1.7 2.05-2.6 3.7-2.6s3 .9 3.7 2.6" />
    </svg>
  );
}

/** 视觉素材图标 */
export function IconVisualAsset({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M10 2.8l6.5 3.75v6.9L10 17.2l-6.5-3.75v-6.9L10 2.8Z" />
      <path d="M3.5 6.55L10 10.3l6.5-3.75" />
      <path d="M10 10.3v6.9" />
    </svg>
  );
}

/** 故事板 / 导演工具箱图标 */
export function IconStoryboard({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <circle cx="10" cy="10" r="6.8" />
      <circle cx="7.6" cy="8.2" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8.2" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="7.8" cy="12.2" r="0.95" fill="currentColor" stroke="none" />
      <path d="M11.6 12.2h2.2" />
    </svg>
  );
}

/** 便签图标 */
export function IconNote({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M4 4.8A1.8 1.8 0 0 1 5.8 3h8.4A1.8 1.8 0 0 1 16 4.8v6.9L11.7 16H5.8A1.8 1.8 0 0 1 4 14.2V4.8Z" />
      <path d="M11.5 16v-3.7a.8.8 0 0 1 .8-.8H16" />
    </svg>
  );
}

/** 资产库文件夹图标 */
export function IconAssetLibrary({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h3.2l1.6 1.8h5.8A1.7 1.7 0 0 1 17 8v6.3a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3V6.2Z" />
      <path d="M3.2 8.6h13.6" />
    </svg>
  );
}

/** 本地上传图标 */
export function IconUpload({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M10 13V4.2" />
      <path d="M6.6 7.5L10 4l3.4 3.5" />
      <path d="M4 13.5v1.3A1.7 1.7 0 0 0 5.7 16.5h8.6a1.7 1.7 0 0 0 1.7-1.7v-1.3" />
    </svg>
  );
}

/** 搜索放大镜图标 */
export function IconSearch({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <circle cx="9" cy="9" r="5.3" />
      <path d="M13.2 13.2L16.8 16.8" />
    </svg>
  );
}

/** 历史时钟图标 */
export function IconClock({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <circle cx="10" cy="10" r="6.8" />
      <path d="M10 6.3v3.9l2.6 1.6" />
    </svg>
  );
}

/** 导出/分享箭头图标 */
export function IconShareExport({ size = 15, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M11.5 4.5l4.5 4.5-4.5 4.5" />
      <path d="M15.8 9H8.5C5.7 9 4 10.8 4 13.8v1.7" />
    </svg>
  );
}

/** 更多三点图标 */
export function IconMoreHorizontal({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...rest}>
      <circle cx="5" cy="10" r="1.4" />
      <circle cx="10" cy="10" r="1.4" />
      <circle cx="15" cy="10" r="1.4" />
    </svg>
  );
}

/** 与 AI 对话 蓝青流光波形图标 */
export function IconAiWave({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" {...rest}>
      <defs>
        <linearGradient id="jm-ai-wave" x1="2" y1="3" x2="18" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <path
        d="M3.5 11.5c1.3-3.2 2.5-5.5 3.8-5.5 1.5 0 1.8 8 3.3 8 1.4 0 2.1-6.5 3.5-6.5 1 0 1.7 1.8 2.4 3.5"
        stroke="url(#jm-ai-wave)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 适应屏幕图标 */
export function IconFitView({ size = 15, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M4 7V4h3" />
      <path d="M13 4h3v3" />
      <path d="M16 13v3h-3" />
      <path d="M7 16H4v-3" />
      <rect x="7.5" y="7.5" width="5" height="5" rx="1" />
    </svg>
  );
}

/** 小地图切换图标 */
export function IconMiniMap({ size = 15, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <rect x="3" y="4" width="14" height="12" rx="2.2" />
      <rect x="10.5" y="9.5" width="4.2" height="4.2" rx="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 音频声波图标 */
export function IconAudio({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" aria-hidden="true" {...rest}>
      <path d="M4 8.5v3" />
      <path d="M7 5.5v9" />
      <path d="M10 3.8v12.4" />
      <path d="M13 6.5v7" />
      <path d="M16 8.5v3" />
    </svg>
  );
}

/** 时间线场记帧图标 */
export function IconTimeline({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <rect x="2.8" y="4.2" width="14.4" height="11.6" rx="2.2" />
      <path d="M2.8 8h14.4" />
      <path d="M7.5 4.2L6.2 8" />
      <path d="M12.5 4.2L11.2 8" />
      <path d="M8.6 10.3l3.4 1.9-3.4 1.9v-3.8Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 导演台立体取景框图标 */
export function IconDirectorStage({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M4 6.2L10 3l6 3.2v6.6L10 16l-6-3.2V6.2Z" />
      <path d="M4 6.2L10 9.5l6-3.3" />
      <path d="M10 9.5V16" />
      <circle cx="10" cy="6.2" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 图层菱形叠片图标 */
export function IconLayers({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M10 3.2l6.5 3.6L10 10.4 3.5 6.8 10 3.2Z" />
      <path d="M3.5 10.2L10 13.8l6.5-3.6" />
      <path d="M3.5 13.5L10 17.1l6.5-3.6" />
    </svg>
  );
}

/** 序列播放三角图标 (▷) */
export function IconPlaySequence({ size = 14, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M6.2 4.5l9 5.5-9 5.5V4.5Z" />
    </svg>
  );
}

/** 贝塞尔连线显隐开关图标 */
export function IconEdgesToggle({ size = 15, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <circle cx="4.5" cy="14" r="2.2" />
      <circle cx="15.5" cy="6" r="2.2" />
      <path d="M6.7 14C10.5 14 9.5 6 13.3 6" />
    </svg>
  );
}

/** 日期排序图标 */
export function IconSortOrder({ size = 15, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M6.5 4.2v11.6" />
      <path d="M4 13.2l2.5 2.6 2.5-2.6" />
      <path d="M11.5 6h5" />
      <path d="M11.5 10h3.8" />
      <path d="M11.5 14h2.5" />
    </svg>
  );
}

/** 筛选漏斗图标 */
export function IconFilter({ size = 15, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M3.5 5h13l-4.8 5.6v4.6l-3.4 1.6v-6.2L3.5 5Z" />
    </svg>
  );
}

/** 电源 / 关闭服务图标 */
export function IconPower({ size = 15, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M10 3.2v6.2" />
      <path d="M6.1 5.4a6.2 6.2 0 1 0 7.8 0" />
    </svg>
  );
}
