import type { StoryboardGrid, StoryboardMode } from "../../store/board";
import type {
  ImageModelKey,
  ImageResolutionKey,
  ImageThinkingLevel,
  MediaProviderKey,
  OmniFlashVersion,
  VideoResolutionKey,
} from "../../store/settings";
import {
  estimateOmniBaseCreditCost,
  estimateVideoUpscaleCreditCost,
  IMAGE_MODEL_CATALOG,
  IMAGE_RESOLUTION_OPTIONS,
  IMAGE_THINKING_OPTIONS,
  OMNI_1_2_DURATIONS,
  OUTPUT_COUNT_OPTIONS,
  VIDEO_MODEL_CATALOG,
  VIDEO_RESOLUTION_OPTIONS,
  type ImageModelCatalogEntry,
  type VideoModelCatalogEntry,
} from "../../constants/models";
import { STORYBOARD_GRIDS, totalPanels } from "../../lib/storyboardPrompt";
import {
  CAMERA_MOVEMENTS,
  IMAGE_ASPECT_RATIOS,
  InfoTip,
  VIDEO_ASPECT_RATIOS,
  type AspectKey,
  type CameraKey,
} from "./aspectHelpers";

interface ModalParameterControlsProps {
  isVideo: boolean;
  isPrompt: boolean;
  isStoryboard: boolean;
  isOmniVideo: boolean;
  accountIssue: string | null;
  mediaProvider: MediaProviderKey;
  setMediaProvider: (p: MediaProviderKey) => void;
  imageModel: ImageModelKey;
  setImageModel: (m: ImageModelKey) => void;
  selectedImageEntry: ImageModelCatalogEntry;
  aspectRatio: AspectKey;
  updateAspectRatio: (ar: AspectKey) => void;
  imageResolution: ImageResolutionKey;
  setImageResolution: (r: ImageResolutionKey) => void;
  imageThinkingLevel: ImageThinkingLevel;
  setImageThinkingLevel: (lvl: ImageThinkingLevel) => void;
  selectedVideoId: VideoModelCatalogEntry["id"];
  applyVideoSelection: (id: VideoModelCatalogEntry["id"]) => void;
  selectedVideoEntry: VideoModelCatalogEntry;
  paygateTier: string | null;
  videoResolution: VideoResolutionKey;
  setVideoResolution: (r: VideoResolutionKey) => void;
  omniVersion: OmniFlashVersion;
  activeVideoDuration: number;
  handleSelectVideoDuration: (sec: number) => void;
  camera: CameraKey;
  setCamera: (c: CameraKey) => void;
  selectedSourceCount: number;
  variants: number;
  updateVariants: (cnt: number) => void;
  seedInput: string;
  setSeedInput: (s: string) => void;
  storyboardMode: StoryboardMode;
  setStoryboardMode: (m: StoryboardMode) => void;
  storyboardGrid: StoryboardGrid;
  setStoryboardGrid: (g: StoryboardGrid) => void;
}

export function ModalParameterControls({
  isVideo,
  isPrompt,
  isStoryboard,
  isOmniVideo,
  accountIssue,
  mediaProvider,
  setMediaProvider,
  imageModel,
  setImageModel,
  selectedImageEntry,
  aspectRatio,
  updateAspectRatio,
  imageResolution,
  setImageResolution,
  imageThinkingLevel,
  setImageThinkingLevel,
  selectedVideoId,
  applyVideoSelection,
  selectedVideoEntry,
  paygateTier,
  videoResolution,
  setVideoResolution,
  omniVersion,
  activeVideoDuration,
  handleSelectVideoDuration,
  camera,
  setCamera,
  selectedSourceCount,
  variants,
  updateVariants,
  seedInput,
  setSeedInput,
  storyboardMode,
  setStoryboardMode,
  storyboardGrid,
  setStoryboardGrid,
}: ModalParameterControlsProps) {
  return (
    <>
      {isVideo && accountIssue && (
        <p className="gen-dialog__hint" role="status">
          {accountIssue}
        </p>
      )}
      {!isVideo && !isPrompt && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            渲染引擎
            <InfoTip tip="Flow：通过 Chrome 扩展桥接 Google Flow 渲染；Muse：通过本地配置的 muse2api 网关或 worker 渲染。" />
          </span>
          <div className="aspect-chip-row">
            <button
              key="flow"
              type="button"
              className={`aspect-chip${mediaProvider === "flow" ? " aspect-chip--active" : ""}`}
              onClick={() => setMediaProvider("flow")}
            >
              Flow
            </button>
            <button
              key="muse"
              type="button"
              className={`aspect-chip${mediaProvider === "muse" ? " aspect-chip--active" : ""}`}
              onClick={() => setMediaProvider("muse")}
            >
              Muse
            </button>
          </div>
        </div>
      )}

      {!isVideo && !isPrompt && mediaProvider === "flow" && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            照片模型
            <InfoTip tip="切换后同步为默认照片模型。Pro 主力写实与汉字；2.1 支持思考深度；Lite 极速批量抽卡。" />
          </span>
          <select
            className="gen-dialog__select"
            value={imageModel}
            onChange={(e) => setImageModel(e.target.value as ImageModelKey)}
          >
            {IMAGE_MODEL_CATALOG.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}（{m.officialBadge}）
              </option>
            ))}
          </select>
          <div className="gen-dialog__model-note">
            {selectedImageEntry.deprecationNote && (
              <div className="gen-dialog__model-deprecation">
                {selectedImageEntry.deprecationNote}
              </div>
            )}
            <div>
              画质：{selectedImageEntry.qualityTier} · 速度：
              {selectedImageEntry.speedTier}
            </div>
            <div>积分：{selectedImageEntry.creditTag}</div>
            <div>适用：{selectedImageEntry.bestFor}</div>
          </div>
        </div>
      )}

      {!isPrompt && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">画幅比例</span>
          <div className="aspect-chip-row">
            {(isVideo ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS).map((ar) => (
              <button
                key={ar.key}
                className={`aspect-chip${aspectRatio === ar.key ? " aspect-chip--active" : ""}`}
                onClick={() => updateAspectRatio(ar.key)}
                type="button"
              >
                {ar.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isVideo && !isPrompt && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            图片清晰度
            <InfoTip tip="1K 原生极速直出；2K/4K 将在生成完成后调用官方 SPrCad 超清重塑。" />
          </span>
          <div className="aspect-chip-row">
            {IMAGE_RESOLUTION_OPTIONS.map((r) => (
              <button
                key={r.value}
                type="button"
                className={`aspect-chip${imageResolution === r.value ? " aspect-chip--active" : ""}`}
                onClick={() => setImageResolution(r.value)}
                title={r.hint}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isVideo && !isPrompt && imageModel === "NANO_BANANA_2_1" && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            思考深度（Nano Banana 2.1）
            <InfoTip tip="提升思考深度可显著改善多主体空间逻辑与文字构图精度。" />
          </span>
          <div className="aspect-chip-row">
            {IMAGE_THINKING_OPTIONS.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`aspect-chip${imageThinkingLevel === t.value ? " aspect-chip--active" : ""}`}
                onClick={() => setImageThinkingLevel(t.value)}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {isVideo && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            视频模型
            <InfoTip tip="含官方停用提示与场景画质建议；Omni 支持多参考图，Veo 3.1 适合首尾帧图生视频。" />
          </span>
          <select
            className="gen-dialog__select"
            value={selectedVideoId}
            onChange={(e) =>
              applyVideoSelection(e.target.value as VideoModelCatalogEntry["id"])
            }
          >
            {VIDEO_MODEL_CATALOG.map((m) => {
              const locked = !!m.ultraOnly && paygateTier !== "PAYGATE_TIER_TWO";
              return (
                <option key={m.id} value={m.id} disabled={locked}>
                  {m.label}
                  {m.deprecationNote
                    ? `（${m.deprecationNote}）`
                    : m.ultraOnly
                      ? "（仅限 Ultra · 0 积分）"
                      : ""}
                </option>
              );
            })}
          </select>
          <div className="gen-dialog__model-note">
            {selectedVideoEntry.deprecationNote && (
              <div className="gen-dialog__model-deprecation">
                {selectedVideoEntry.deprecationNote}
              </div>
            )}
            <div>
              画质：{selectedVideoEntry.qualityTier} ·{" "}
              {selectedVideoEntry.speedTier}
            </div>
            <div>积分：{selectedVideoEntry.creditTag}</div>
            <div>适用：{selectedVideoEntry.bestFor}</div>
          </div>
        </div>
      )}

      {isVideo && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            视频分辨率
            <InfoTip tip="360p（Omni 专属，约 720p 的 1/3 积分）/ 720p 为原生输出；1080p（Plus/Pro/Ultra：1–10秒 0 附加分，超10秒 +1分/秒）；4K（仅 Ultra：1–10秒 +50分/条，超10秒 +5分/秒）。" />
          </span>
          <div className="aspect-chip-row">
            {VIDEO_RESOLUTION_OPTIONS.map((r) => {
              const unsupported = !!r.omniOnly && !isOmniVideo;
              return (
                <button
                  key={r.value}
                  type="button"
                  className={`aspect-chip${videoResolution === r.value ? " aspect-chip--active" : ""}`}
                  onClick={() => setVideoResolution(r.value)}
                  disabled={unsupported}
                  title={
                    unsupported
                      ? "仅 Omni Flash 支持 360p，Veo 3.1 原生 720p 起"
                      : r.hint
                  }
                >
                  {unsupported ? `${r.label} (仅Omni)` : r.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {isVideo && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            {isOmniVideo
              ? `生成时长 (Omni ${omniVersion})`
              : "生成时长（支持 3–15 秒调节）"}
            <InfoTip
              tip={
                isOmniVideo
                  ? omniVersion === "1.2"
                    ? "Omni 1.2 Flash 支持 3–15 秒连续时长（11–15 秒需 Plus/Ultra）。"
                    : "Omni 1.1 Flash 原生支持 4/6/8/10 秒；选其他秒数将自动升级至 Omni 1.2 Flash。"
                  : "Veo 3.1 官方固定 8 秒；拖动滑块或点选其他秒数将自动切换至支持 3–15 秒的 Omni 1.2 Flash。"
              }
            />
          </span>
          <div className="gen-dialog__duration-control">
            <div className="gen-dialog__duration-slider-row">
              <input
                type="range"
                className="gen-dialog__duration-slider"
                min={3}
                max={15}
                step={1}
                value={activeVideoDuration}
                onChange={(e) =>
                  handleSelectVideoDuration(Number(e.target.value))
                }
                aria-label="视频时长滑块"
              />
              <span className="gen-dialog__duration-readout">
                {activeVideoDuration} 秒
                {isOmniVideo
                  ? (() => {
                      const effectiveVer =
                        omniVersion === "1.1" && ![4, 6, 8, 10].includes(activeVideoDuration)
                          ? "1.2"
                          : omniVersion;
                      const unit =
                        estimateOmniBaseCreditCost(effectiveVer, activeVideoDuration, videoResolution) +
                        estimateVideoUpscaleCreditCost(videoResolution, activeVideoDuration);
                      return ` · ${unit}积分/条`;
                    })()
                  : ""}
              </span>
            </div>
            <div className="aspect-chip-row">
              {OMNI_1_2_DURATIONS.map((d) => {
                const active = activeVideoDuration === d;
                const perClipCost = isOmniVideo
                  ? (() => {
                      const effectiveVer =
                        omniVersion === "1.1" && ![4, 6, 8, 10].includes(d)
                          ? "1.2"
                          : omniVersion;
                      return (
                        estimateOmniBaseCreditCost(effectiveVer, d, videoResolution) +
                        estimateVideoUpscaleCreditCost(videoResolution, d)
                      );
                    })()
                  : undefined;
                const creditSuffix =
                  perClipCost != null ? ` · ${perClipCost}积分` : "";
                return (
                  <button
                    key={d}
                    type="button"
                    className={`aspect-chip${active ? " aspect-chip--active" : ""}`}
                    onClick={() => handleSelectVideoDuration(d)}
                  >
                    {d}秒{creditSuffix}
                  </button>
                );
              })}
            </div>
            {!isOmniVideo && (
              <p className="gen-dialog__hint">
                Veo 3.1 官方固定 8 秒；选择任意非 8 秒时长将自动切换至 Omni 1.2
                Flash。
              </p>
            )}
          </div>
        </div>
      )}

      {isVideo && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            镜头运动
            <InfoTip tip="固定机位：锁定画幅不推拉摇移，适合电商商品展示防止裁切；动态运镜：由 AI 根据场景自动设计推轨/摇移运镜。" />
          </span>
          <div className="aspect-chip-row">
            {CAMERA_MOVEMENTS.map((c) => (
              <button
                key={c.key}
                className={`aspect-chip${camera === c.key ? " aspect-chip--active" : ""}`}
                onClick={() => setCamera(c.key)}
                type="button"
                title={c.instruction}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isPrompt && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">输出数量</span>
          {isVideo && !isOmniVideo && selectedSourceCount > 1 ? (
            <div className="aspect-chip-row">
              <span className="jm-context-generator__badge">
                已选 {selectedSourceCount} 张参考帧（每帧生成 1 条，共{" "}
                {selectedSourceCount} 条）
              </span>
            </div>
          ) : (
            <div className="aspect-chip-row">
              {OUTPUT_COUNT_OPTIONS.map((cnt) => (
                <button
                  key={cnt}
                  type="button"
                  className={`aspect-chip${variants === cnt ? " aspect-chip--active" : ""}`}
                  onClick={() => updateVariants(cnt)}
                >
                  x{cnt}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!isVideo && !isPrompt && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            固定随机种子（Seed，可选）
            <InfoTip tip="填入正整数可复现相近构图与随机噪点分布；留空由 Flow 自动随机采样。" />
          </span>
          <input
            type="text"
            inputMode="numeric"
            className="gen-dialog__seed-input"
            value={seedInput}
            onChange={(e) =>
              setSeedInput(e.target.value.replace(/[^\d]/g, "").slice(0, 12))
            }
            placeholder="留空随机生成（或输入如 421088 以复现种子）"
          />
        </div>
      )}

      {isStoryboard && (
        <>
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              分镜模式
              <InfoTip tip="剧情连贯：按时间推进演绎前后情节；同场多机位：锁定同一人物与场景同步拍摄多机位角度，生成后可一键切分。" />
            </span>
            <div className="aspect-chip-row">
              <button
                type="button"
                className={`aspect-chip${storyboardMode === "narrative" ? " aspect-chip--active" : ""}`}
                onClick={() => setStoryboardMode("narrative")}
              >
                剧情连贯分镜
              </button>
              <button
                type="button"
                className={`aspect-chip${storyboardMode === "multicam" ? " aspect-chip--active" : ""}`}
                onClick={() => setStoryboardMode("multicam")}
              >
                同场多机位（可切分重用）
              </button>
            </div>
          </div>
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              分镜宫格布局
              <InfoTip tip="故事板将以单张高清多宫格分镜图渲染输出，3×3 为九宫格标准方阵，生成后支持一键无损切分为独立节点。" />
            </span>
            <div className="aspect-chip-row">
              {STORYBOARD_GRIDS.map((g) => {
                const total = totalPanels(g);
                const isPortrait = aspectRatio.includes("PORTRAIT");
                let dimsLabel = "2×2";
                if (g === "3x3") {
                  dimsLabel = "3×3";
                } else if (g !== "2x2") {
                  const big = g === "2x3" ? 3 : 4;
                  dimsLabel = isPortrait ? `${big}×2` : `2×${big}`;
                }
                return (
                  <button
                    key={g}
                    type="button"
                    className={`aspect-chip${storyboardGrid === g ? " aspect-chip--active" : ""}`}
                    onClick={() => setStoryboardGrid(g)}
                    title={`${total} 格分镜 (${dimsLabel})`}
                  >
                    {dimsLabel} · {total} 格
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}
