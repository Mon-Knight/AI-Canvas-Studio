/**
 * 左栏「ılı 音频 → 🎙 声画导演」工作舱（即梦深空毛玻璃居中浮窗）：
 * - Tab 1: 🎙️ 视频声画台词与音效编排（人声音色 + 口型台词 + 动作音效 + 环境声场 -> 写入 Flow 视频节点）
 * - Tab 2: 🎵 时间线全局配乐 / 旁白音轨（一键挂载画布音频/分轨节点或持久化上传本地音轨 + 尾段淡出控制）
 * - Tab 3: ✨ Flow Music AI 配乐（个人 Flow Music 积分通道直连 Lyria 3.5 / 3 Pro 作曲）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl, patchNode } from "../api/client";
import { uploadAudioFile } from "../api/music";
import { MUSIC_STEM_META } from "../constants/models";
import { displayNodeTitle } from "../constants/nodeLabels";
import { useBoardStore } from "../store/board";
import { useGenerationStore } from "../store/generation";
import {
  AMBIENCE_PRESETS,
  VOICE_PRESETS,
  composeAudioDirective,
  useTimelineAudioStore,
} from "../store/timelineAudio";
import { MusicComposerPanel } from "./generation/MusicComposerPanel";

export type AudioDirectorTab = "voice" | "bgm" | "ai_music";

interface OpenAudioDirectorDetail {
  tab?: AudioDirectorTab;
  rfId?: string;
}

interface CanvasAudioChoice {
  mediaId: string;
  label: string;
  tag: string;
}

function mergeAudioDirectiveIntoPrompt(existingPrompt: string | undefined, directive: string): string {
  const base = (existingPrompt ?? "")
    .replace(/\n*【声画指令】[^\n]*/g, "")
    .trim();
  if (!directive) return base;
  return base ? `${base}\n${directive}` : directive;
}

export function AudioDirectorModal() {
  const nodes = useBoardStore((s) => s.nodes);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AudioDirectorTab>("voice");
  const [targetRfId, setTargetRfId] = useState<string>("");
  const [voiceKey, setVoiceKey] = useState<string>(VOICE_PRESETS[0].key);
  const [ambienceKey, setAmbienceKey] = useState<string>(AMBIENCE_PRESETS[0].key);
  const [dialogue, setDialogue] = useState("");
  const [sfx, setSfx] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadingBgm, setUploadingBgm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const audioFileRef = useRef<HTMLInputElement | null>(null);

  const bgmName = useTimelineAudioStore((s) => s.bgmName);
  const bgmUrl = useTimelineAudioStore((s) => s.bgmUrl);
  const bgmMediaId = useTimelineAudioStore((s) => s.bgmMediaId);
  const bgmVolume = useTimelineAudioStore((s) => s.bgmVolume);
  const bgmFadeOutSec = useTimelineAudioStore((s) => s.bgmFadeOutSec);
  const videoAudioMuted = useTimelineAudioStore((s) => s.videoAudioMuted);
  const setBgmFile = useTimelineAudioStore((s) => s.setBgmFile);
  const setBgmMediaAsset = useTimelineAudioStore((s) => s.setBgmMediaAsset);
  const setBgmVolume = useTimelineAudioStore((s) => s.setBgmVolume);
  const setBgmFadeOutSec = useTimelineAudioStore((s) => s.setBgmFadeOutSec);
  const setVideoAudioMuted = useTimelineAudioStore((s) => s.setVideoAudioMuted);

  const videoNodes = useMemo(
    () => nodes.filter((n) => n.data.type === "video"),
    [nodes],
  );

  // 收集当前画布所有已生成的音频节点及分轨，便于一键挂载为时间线 BGM
  const canvasAudioChoices = useMemo<CanvasAudioChoice[]>(() => {
    const out: CanvasAudioChoice[] = [];
    for (const n of nodes) {
      if (n.data.type !== "audio") continue;
      const baseTitle = n.data.musicTitle || displayNodeTitle(n.data.title, "audio");
      const mid = n.data.mediaId || n.data.mediaIds?.find(Boolean);
      if (mid) {
        out.push({
          mediaId: mid,
          label: `${baseTitle} (#${n.data.shortId})`,
          tag: n.data.musicModel || "完整音轨",
        });
      }
      if (n.data.musicStems && typeof n.data.musicStems === "object") {
        for (const [stemKey, stemMid] of Object.entries(n.data.musicStems)) {
          if (typeof stemMid !== "string" || !stemMid) continue;
          const meta = MUSIC_STEM_META[stemKey] ?? { label: stemKey, icon: "🎵" };
          out.push({
            mediaId: stemMid,
            label: `${baseTitle} · ${meta.label}`,
            tag: `${meta.icon} 分轨`,
          });
        }
      }
    }
    return out;
  }, [nodes]);

  const targetVideo = useMemo(
    () => videoNodes.find((n) => n.id === targetRfId) ?? videoNodes[0] ?? null,
    [videoNodes, targetRfId],
  );

  const previewDirective = useMemo(
    () =>
      composeAudioDirective({
        voiceKey,
        dialogue,
        sfx,
        ambienceKey,
      }),
    [voiceKey, dialogue, sfx, ambienceKey],
  );

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<OpenAudioDirectorDetail | undefined>).detail;
      const curNodes = useBoardStore.getState().nodes;
      const vids = curNodes.filter((n) => n.data.type === "video");
      const picked =
        (detail?.rfId && vids.find((n) => n.id === detail.rfId)) ||
        vids.find((n) => n.selected) ||
        vids[0] ||
        null;
      setTargetRfId(picked?.id ?? "");
      setTab(detail?.tab ?? "voice");
      setNotice(null);
      setError(null);
      setOpen(true);
    };
    window.addEventListener("flowboard:open-audio-director", onOpen);
    return () => window.removeEventListener("flowboard:open-audio-director", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleCreateVideoNode() {
    const { boardId, addNodeOfType, setNodes } = useBoardStore.getState();
    if (boardId === null) {
      setError("请先打开或创建一个画布项目");
      return;
    }
    setError(null);
    const id = await addNodeOfType("video", { x: 240, y: 180 });
    if (id) {
      const cur = useBoardStore.getState().nodes;
      setNodes(cur.map((n) => ({ ...n, selected: n.id === id })));
      setTargetRfId(id);
    }
  }

  async function persistAudioDirective(openGenAfter: boolean) {
    if (!targetVideo || !previewDirective || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const mergedPrompt = mergeAudioDirectiveIntoPrompt(
        targetVideo.data.prompt,
        previewDirective,
      );
      useBoardStore.getState().updateNodeData(targetVideo.id, {
        audioPrompt: previewDirective,
        prompt: mergedPrompt,
      });
      const dbId = parseInt(targetVideo.id, 10);
      if (!isNaN(dbId)) {
        await patchNode(dbId, {
          data: {
            audioPrompt: previewDirective,
            prompt: mergedPrompt,
          },
        });
      }
      if (openGenAfter) {
        const curNodes = useBoardStore.getState().nodes;
        useBoardStore.getState().setNodes(
          curNodes.map((n) => ({ ...n, selected: n.id === targetVideo.id })),
        );
        setOpen(false);
        useGenerationStore
          .getState()
          .openGenerationDialog(targetVideo.id, mergedPrompt);
        return;
      }
      setNotice("✓ 已将声画指令写入该视频节点，生成 Veo / Omni 视频时将自动生效。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "写入声画指令失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleUploadPersistentBgm(file: File) {
    if (uploadingBgm) return;
    setUploadingBgm(true);
    setError(null);
    setNotice(null);
    try {
      const uploaded = await uploadAudioFile(file);
      const cleanName = file.name.replace(/\.[^.]+$/, "") || file.name;
      setBgmMediaAsset({
        mediaId: uploaded.media_id,
        name: cleanName,
        url: mediaUrl(uploaded.media_id),
      });
      setNotice("✓ 已上传并持久化挂载为时间线全局配乐，刷新页面后依然保留。");
    } catch {
      // 若本地服务暂不可用则回退为会话内 Blob URL
      setBgmFile(file);
    } finally {
      setUploadingBgm(false);
    }
  }

  function handleGoTimeline() {
    setOpen(false);
    window.dispatchEvent(new Event("flowboard:open-sequence-player"));
  }

  if (!open) return null;

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="gen-dialog jm-audio-modal"
        role="dialog"
        aria-modal="true"
        aria-label="声画导演与全局音轨"
      >
        <div className="gen-dialog__header">
          <div>
            <h2 className="gen-dialog__title">ılı 声画导演 · 台词音效与 Flow Music 配乐中心</h2>
            <span className="gen-dialog__subtitle">
              驱动 Veo / Omni 口型台词音效、通过个人 Flow Music 通道 AI 作曲，并为时间线成片混音全局 BGM
            </span>
          </div>
          <button
            type="button"
            className="gen-dialog__close"
            onClick={() => setOpen(false)}
            aria-label="关闭声画导演"
          >
            ✕
          </button>
        </div>

        <div className="jm-director-modal__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "voice"}
            className={`aspect-chip${tab === "voice" ? " aspect-chip--active" : ""}`}
            onClick={() => setTab("voice")}
          >
            🎙️ 视频声画台词与音效
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "bgm"}
            className={`aspect-chip${tab === "bgm" ? " aspect-chip--active" : ""}`}
            onClick={() => setTab("bgm")}
          >
            🎵 时间线全局配乐轨
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "ai_music"}
            className={`aspect-chip${tab === "ai_music" ? " aspect-chip--active" : ""}`}
            onClick={() => setTab("ai_music")}
          >
            ✨ Flow Music AI 配乐
          </button>
        </div>

        <div className="gen-dialog__body">
          {tab === "voice" ? (
            <>
              <div className="jm-audio-node-row">
                <label className="jm-layer-source-picker" style={{ flex: 1 }}>
                  <span>目标视频节点</span>
                  {videoNodes.length > 0 ? (
                    <select
                      value={targetVideo?.id ?? ""}
                      onChange={(e) => {
                        setTargetRfId(e.target.value);
                        setNotice(null);
                      }}
                    >
                      {videoNodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {displayNodeTitle(n.data.title, n.data.type)} (#{n.data.shortId})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="jm-audio-empty-hint">画布暂无视频节点</span>
                  )}
                </label>
                <button
                  type="button"
                  className="jm-seq-ctrl-btn"
                  onClick={() => void handleCreateVideoNode()}
                >
                  ➕ 新建视频镜头节点
                </button>
              </div>

              <div className="gen-dialog__field">
                <span className="gen-dialog__label">人声音色与情绪预设</span>
                <div className="aspect-chip-row" style={{ flexWrap: "wrap" }}>
                  {VOICE_PRESETS.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      className={`aspect-chip${voiceKey === v.key ? " aspect-chip--active" : ""}`}
                      onClick={() => setVoiceKey(v.key)}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="gen-dialog__field">
                <span className="gen-dialog__label">口型同步台词 / 旁白正文（Dialogue）</span>
                <textarea
                  className="gen-dialog__textarea"
                  rows={2}
                  value={dialogue}
                  onChange={(e) => setDialogue(e.target.value)}
                  placeholder="例如：雨停之后，霓虹比刚才更亮了，我们走吧。"
                />
              </div>

              <div className="gen-dialog__field">
                <span className="gen-dialog__label">关键动作拟音音效（SFX）</span>
                <input
                  type="text"
                  className="gen-dialog__seed-input"
                  style={{ width: "100%" }}
                  value={sfx}
                  onChange={(e) => setSfx(e.target.value)}
                  placeholder="例如：皮鞋踩过浅水洼飞溅水声、风铃清脆碰撞声"
                />
              </div>

              <div className="gen-dialog__field">
                <span className="gen-dialog__label">环境声场与氛围底噪</span>
                <div className="aspect-chip-row" style={{ flexWrap: "wrap" }}>
                  {AMBIENCE_PRESETS.map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      className={`aspect-chip${ambienceKey === a.key ? " aspect-chip--active" : ""}`}
                      onClick={() => setAmbienceKey(a.key)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="jm-audio-preview-box">
                <span className="gen-dialog__label">将合成的 Flow 原生声画指令预览</span>
                <p>{previewDirective || "请选择预设或输入台词/音效"}</p>
              </div>

              {error && <p className="visual-asset__error" role="alert">{error}</p>}
              {notice && <p className="jm-audio-success-msg">{notice}</p>}

              <div className="jm-audio-actions">
                <button
                  type="button"
                  className="jm-seq-ctrl-btn"
                  disabled={!targetVideo || !previewDirective || saving}
                  onClick={() => void persistAudioDirective(false)}
                >
                  {saving ? "写入中…" : "💾 写入镜头声画设定"}
                </button>
                <button
                  type="button"
                  className="gen-dialog__cta"
                  disabled={!targetVideo || !previewDirective || saving}
                  onClick={() => void persistAudioDirective(true)}
                >
                  🚀 写入并打开视频生成栏
                </button>
              </div>
            </>
          ) : tab === "bgm" ? (
            <>
              <input
                ref={audioFileRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (file) void handleUploadPersistentBgm(file);
                  e.target.value = "";
                }}
              />

              {canvasAudioChoices.length > 0 && (
                <div className="gen-dialog__field">
                  <span className="gen-dialog__label">从当前画布音频节点 / 分轨一键挂载</span>
                  <div className="jm-audio-canvas-picks">
                    {canvasAudioChoices.map((choice) => {
                      const active = bgmMediaId === choice.mediaId;
                      return (
                        <button
                          key={choice.mediaId}
                          type="button"
                          className={`jm-audio-canvas-pick${active ? " jm-audio-canvas-pick--active" : ""}`}
                          onClick={() =>
                            setBgmMediaAsset({
                              mediaId: choice.mediaId,
                              name: choice.label,
                              url: mediaUrl(choice.mediaId),
                            })
                          }
                        >
                          <span className="jm-audio-canvas-pick__name">
                            {active ? "✓ " : "🎵 "}
                            {choice.label}
                          </span>
                          <span className="jm-audio-canvas-pick__tag">{choice.tag}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="jm-audio-bgm-card">
                <div>
                  <strong className="jm-audio-bgm-card__title">
                    {bgmName ? `当前配乐轨：${bgmName}` : "尚未挂载配乐 / 旁白音频文件"}
                  </strong>
                  <p className="jm-audio-bgm-card__desc">
                    支持 MP3、WAV、M4A、OGG、AAC 格式，上传后自动缓存至本地媒体库并在「时间线」预览与导出成片时自动混音。
                  </p>
                </div>
                <div className="jm-layer-mini-actions">
                  <button
                    type="button"
                    className="gen-dialog__cta"
                    disabled={uploadingBgm}
                    onClick={() => audioFileRef.current?.click()}
                  >
                    {uploadingBgm
                      ? "上传缓存中…"
                      : `🎵 ${bgmName ? "上传更换配乐" : "上传本地配乐 / 旁白"}`}
                  </button>
                  <button
                    type="button"
                    className="jm-seq-ctrl-btn jm-seq-ctrl-btn--cyan"
                    onClick={() => setTab("ai_music")}
                  >
                    ✨ 用 Flow Music AI 作曲
                  </button>
                  {bgmName && (
                    <button
                      type="button"
                      className="jm-seq-ctrl-btn"
                      onClick={() => setBgmMediaAsset(null)}
                    >
                      ✕ 移除音轨
                    </button>
                  )}
                </div>

                {bgmUrl && (
                  <audio
                    className="jm-audio-bgm-player"
                    src={bgmUrl}
                    controls
                  />
                )}
              </div>

              <div className="jm-audio-mixer-panel">
                <label className="jm-layer-slider">
                  <span>全局配乐混音音量：{Math.round(bgmVolume * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(bgmVolume * 100)}
                    onChange={(e) => setBgmVolume(Number(e.target.value) / 100)}
                  />
                </label>

                <label className="jm-layer-slider">
                  <span>成片结尾配乐自然淡出：{bgmFadeOutSec.toFixed(1)} 秒</span>
                  <input
                    type="range"
                    min={0}
                    max={6}
                    step={0.5}
                    value={bgmFadeOutSec}
                    onChange={(e) => setBgmFadeOutSec(Number(e.target.value))}
                  />
                </label>

                <label className="jm-audio-toggle-row">
                  <input
                    type="checkbox"
                    checked={!videoAudioMuted}
                    onChange={(e) => setVideoAudioMuted(!e.target.checked)}
                  />
                  <span>导出与连播时保留各视频镜头原生环境声与台词（推荐开启）</span>
                </label>
              </div>

              {notice && <p className="jm-audio-success-msg">{notice}</p>}

              <div className="jm-audio-actions">
                <button
                  type="button"
                  className="gen-dialog__cta"
                  onClick={handleGoTimeline}
                >
                  🎞️ 前往时间线预览与一键合成成片 →
                </button>
              </div>
            </>
          ) : (
            <MusicComposerPanel
              embedded
              onDispatched={() => {
                // 保持弹窗开启让用户看到入队提示，或可点击前往画布/时间线
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
