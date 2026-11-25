import { useRef, useState } from "react";
import { mediaUrl, patchNode } from "../api/client";
import {
  analyzeCachedAudio,
  flowMusicDownloadUrl,
  uploadAudioFile,
} from "../api/music";
import { MUSIC_STEM_META } from "../constants/models";
import { displayNodeTitle } from "../constants/nodeLabels";
import { useBoardStore, type FlowboardNodeData } from "../store/board";
import { useGenerationStore } from "../store/generation";
import { useReferencesStore } from "../store/references";
import { useTimelineAudioStore } from "../store/timelineAudio";

const ACCEPT_AUDIO = "audio/*,.mp3,.wav,.m4a,.ogg,.aac";
const STEM_ORDER = ["vocals", "drums", "bass", "other"] as const;

function formatDuration(sec: number | undefined): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return null;
  const total = Math.round(sec);
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${mins}:${rem.toString().padStart(2, "0")}`;
}

export function AudioNodeBody({
  rfId,
  data,
}: {
  rfId: string;
  data: FlowboardNodeData;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [splittingToNodes, setSplittingToNodes] = useState(false);
  const [stemsExpanded, setStemsExpanded] = useState(false);
  const [lyricsExpanded, setLyricsExpanded] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const bgmMediaId = useTimelineAudioStore((s) => s.bgmMediaId);
  const setBgmMediaAsset = useTimelineAudioStore((s) => s.setBgmMediaAsset);

  const isProcessing = data.status === "queued" || data.status === "running";
  const mediaList = (data.mediaIds ?? []).filter(
    (m): m is string => typeof m === "string" && m.length > 0,
  );
  const activeMediaId = data.mediaId || mediaList[0] || "";
  const activeIdx = Math.max(0, mediaList.indexOf(activeMediaId));
  const activeClipId =
    data.musicClipId ||
    (Array.isArray(data.musicClipIds) ? data.musicClipIds[activeIdx] : undefined) ||
    "";
  const stems = data.musicStems && typeof data.musicStems === "object" ? data.musicStems : null;
  const stemEntries = stems
    ? STEM_ORDER.filter((k) => typeof stems[k] === "string" && stems[k].length > 0).map(
        (k) => [k, stems[k]] as const,
      )
    : [];
  const hasStems = stemEntries.length > 0;
  const isCurrentBgm = Boolean(activeMediaId && bgmMediaId === activeMediaId);
  const displayTitle = data.musicTitle || displayNodeTitle(data.title, "audio");
  const durLabel = formatDuration(data.musicDurationSec);

  async function handleUploadFile(file: File) {
    if (uploading) return;
    setLocalError(null);
    setUploading(true);
    try {
      const dbId = parseInt(rfId, 10);
      const res = await uploadAudioFile(file, isNaN(dbId) ? undefined : dbId);
      const cleanTitle = file.name.replace(/\.[^.]+$/, "") || "音频素材";
      const nowIso = new Date().toISOString();
      useBoardStore.getState().updateNodeData(rfId, {
        title: cleanTitle,
        musicTitle: cleanTitle,
        mediaId: res.media_id,
        mediaIds: [res.media_id],
        variantCount: 1,
        status: "done",
        error: undefined,
        renderedAt: nowIso,
      });
      if (!isNaN(dbId)) {
        await patchNode(dbId, {
          status: "done",
          data: {
            title: cleanTitle,
            musicTitle: cleanTitle,
            mediaId: res.media_id,
            mediaIds: [res.media_id],
            variantCount: 1,
            renderedAt: nowIso,
          },
        }).catch(() => {});
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "上传音频失败");
    } finally {
      setUploading(false);
    }
  }

  function handleSelectVariant(idx: number) {
    const nextMid = mediaList[idx];
    if (!nextMid || nextMid === activeMediaId) return;
    const nextClip = data.musicClipIds?.[idx] || data.musicClipId;
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: nextMid,
      ...(nextClip ? { musicClipId: nextClip } : {}),
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, {
        data: {
          mediaId: nextMid,
          ...(nextClip ? { musicClipId: nextClip } : {}),
        },
      }).catch(() => {});
    }
  }

  function handleMountBgm(mediaId: string, label: string) {
    setBgmMediaAsset({
      mediaId,
      name: label,
      url: mediaUrl(mediaId),
    });
  }

  async function handleSplitOrToggleStems() {
    if (hasStems) {
      setStemsExpanded((v) => !v);
      return;
    }
    if (!activeClipId || isProcessing) return;
    setLocalError(null);
    setStemsExpanded(true);
    await useGenerationStore.getState().dispatchMusicSplitStems(rfId, activeClipId);
  }

  async function handleSpawnStemNodes() {
    if (!hasStems || splittingToNodes) return;
    setSplittingToNodes(true);
    setLocalError(null);
    try {
      const board = useBoardStore.getState();
      const current = board.nodes.find((n) => n.id === rfId);
      const baseX = (current?.position.x ?? 120) + 330;
      const baseY = current?.position.y ?? 120;
      const nowIso = new Date().toISOString();

      for (let i = 0; i < stemEntries.length; i += 1) {
        const [stemKey, stemMediaId] = stemEntries[i];
        const meta = MUSIC_STEM_META[stemKey] ?? { label: stemKey, icon: "🎵" };
        const stemTitle = `${displayTitle} · ${meta.label}`;
        const newRfId = await board.addNodeOfType("audio", {
          x: baseX,
          y: baseY + i * 185,
        });
        if (!newRfId) continue;
        useBoardStore.getState().updateNodeData(newRfId, {
          title: stemTitle,
          musicTitle: stemTitle,
          mediaId: stemMediaId,
          mediaIds: [stemMediaId],
          variantCount: 1,
          status: "done",
          musicModel: data.musicModel,
          musicBpm: data.musicBpm,
          musicDurationSec: data.musicDurationSec,
          musicInstrumental: stemKey !== "vocals",
          renderedAt: nowIso,
        });
        const dbId = parseInt(newRfId, 10);
        if (!isNaN(dbId)) {
          await patchNode(dbId, {
            status: "done",
            data: {
              title: stemTitle,
              musicTitle: stemTitle,
              mediaId: stemMediaId,
              mediaIds: [stemMediaId],
              variantCount: 1,
              musicModel: data.musicModel,
              musicBpm: data.musicBpm,
              musicDurationSec: data.musicDurationSec,
              musicInstrumental: stemKey !== "vocals",
              renderedAt: nowIso,
            },
          }).catch(() => {});
        }
        await board.addEdgeFromConnection(rfId, newRfId);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "拆分独立音轨节点失败");
    } finally {
      setSplittingToNodes(false);
    }
  }

  async function handleDeriveNextAudio() {
    const board = useBoardStore.getState();
    const current = board.nodes.find((n) => n.id === rfId);
    const pos = {
      x: (current?.position.x ?? 120) + 320,
      y: current?.position.y ?? 120,
    };
    const newRfId = await board.addNodeOfType("audio", pos);
    if (!newRfId) return;
    await board.addEdgeFromConnection(rfId, newRfId);
    const curNodes = useBoardStore.getState().nodes;
    useBoardStore.getState().setNodes(
      curNodes.map((n) => ({ ...n, selected: n.id === newRfId })),
    );
    useGenerationStore.getState().openGenerationDialog(newRfId, data.prompt ?? "");
  }

  async function handleAnalyzeUploadedAudio() {
    if (!activeMediaId || analyzing) return;
    setAnalyzing(true);
    setLocalError(null);
    try {
      const dbId = parseInt(rfId, 10);
      const res = await analyzeCachedAudio({
        mediaId: activeMediaId,
        nodeId: isNaN(dbId) ? undefined : dbId,
      });
      useBoardStore.getState().updateNodeData(rfId, {
        musicClipId: res.clip_id,
        musicClipIds: [res.clip_id],
        ...(res.caption ? { aiBrief: res.caption, prompt: data.prompt || res.caption } : {}),
        ...(res.lyrics ? { musicLyrics: res.lyrics } : {}),
      });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "解析参考音频失败");
    } finally {
      setAnalyzing(false);
    }
  }

  function handleSaveToLibrary() {
    if (!activeMediaId) return;
    void useReferencesStore.getState().save({
      media_id: activeMediaId,
      kind: "audio",
      ai_brief: data.aiBrief || data.prompt || null,
      label: displayTitle.slice(0, 80),
      source_board_id: useBoardStore.getState().boardId ?? null,
      source_node_short_id: data.shortId ?? null,
    });
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1800);
  }

  function openComposer(e?: React.MouseEvent) {
    e?.stopPropagation();
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  const hiddenInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept={ACCEPT_AUDIO}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) void handleUploadFile(f);
      }}
    />
  );

  // 空状态
  if (!activeMediaId && !isProcessing) {
    return (
      <div
        className="node-body node-body--audio"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleUploadFile(f);
        }}
      >
        {hiddenInput}
        <div className={`character-empty jm-audio-empty${dragOver ? " character-empty--over" : ""}`}>
          {dragOver ? (
            <span className="visual-asset__hint">松开上传音频素材</span>
          ) : (
            <>
              <button
                type="button"
                className="visual-asset__action nodrag"
                onClick={(e) => {
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
                disabled={uploading}
              >
                {uploading ? "上传中…" : "上传音频"}
              </button>
              <button
                type="button"
                className="visual-asset__action jm-audio-empty__cta nodrag"
                onClick={openComposer}
                disabled={uploading}
              >
                🎵 AI 作曲
              </button>
            </>
          )}
        </div>
        {data.prompt && (
          <p className="brief-hint" title={data.prompt}>
            🎵 {data.prompt}
          </p>
        )}
        {(localError || data.error) && (
          <p className="node-error" role="alert">
            {localError || data.error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="node-body node-body--audio">
      {hiddenInput}

      {isProcessing && (
        <div className="jm-video-stage" role="status">
          <span className="jm-video-stage__dot" aria-hidden="true" />
          {data.status === "queued"
            ? "排队中，等待 Flow Music 个人通道…"
            : "Flow Music 正在生成音频，请稍候…"}
        </div>
      )}

      {activeMediaId && (
        <div className="jm-audio-card">
          <div className="jm-audio-card__head">
            {data.musicCoverMediaId ? (
              <img
                className="jm-audio-card__cover"
                src={mediaUrl(data.musicCoverMediaId)}
                alt={displayTitle}
              />
            ) : (
              <div className="jm-audio-card__disc" aria-hidden="true">
                ılı
              </div>
            )}
            <div className="jm-audio-card__meta">
              <div className="jm-audio-card__title" title={displayTitle}>
                {displayTitle}
              </div>
              <div className="jm-audio-card__tags">
                {data.musicModel && <span className="jm-audio-tag">{data.musicModel}</span>}
                {durLabel && <span className="jm-audio-tag">{durLabel}</span>}
                {typeof data.musicBpm === "number" && data.musicBpm > 0 && (
                  <span className="jm-audio-tag">{data.musicBpm} BPM</span>
                )}
                {data.musicInstrumental !== undefined && (
                  <span className="jm-audio-tag">
                    {data.musicInstrumental ? "纯音乐" : "人声"}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* A/B 双版本快速切换 */}
          {mediaList.length > 1 && (
            <div className="jm-audio-ab-row nodrag" role="tablist" aria-label="切换 A/B 音频版本">
              {mediaList.map((mid, idx) => (
                <button
                  key={mid}
                  type="button"
                  role="tab"
                  aria-selected={idx === activeIdx}
                  className={`jm-audio-ab-btn${idx === activeIdx ? " jm-audio-ab-btn--active" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectVariant(idx);
                  }}
                >
                  {idx === 0 ? "版本 A" : idx === 1 ? "版本 B" : `版本 ${idx + 1}`}
                </button>
              ))}
            </div>
          )}

          {/* 原生音频播放器 */}
          <audio
            key={activeMediaId}
            className="jm-audio-player nodrag"
            src={mediaUrl(activeMediaId)}
            controls
            preload="metadata"
            onClick={(e) => e.stopPropagation()}
          />

          {/* 快捷操作区 */}
          <div className="jm-audio-actions-grid nodrag">
            <button
              type="button"
              className={`jm-audio-chip${isCurrentBgm ? " jm-audio-chip--cyan" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                handleMountBgm(activeMediaId, displayTitle);
              }}
              title="将此音轨挂载为时间线全局配乐并持久化保存"
            >
              {isCurrentBgm ? "✓ 已设为 BGM" : "🎞️ 设为 BGM"}
            </button>

            {activeClipId ? (
              <>
                <button
                  type="button"
                  className={`jm-audio-chip${hasStems && stemsExpanded ? " jm-audio-chip--cyan" : ""}`}
                  disabled={isProcessing}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleSplitOrToggleStems();
                  }}
                  title={hasStems ? "展开或收起 4 轨分轨面板" : "使用 Flow Music 四轨分轨（0 积分）"}
                >
                  {hasStems ? (stemsExpanded ? "🎚️ 收起分轨" : "🎚️ 4轨分轨 ✓") : "🎚️ 分轨 (0分)"}
                </button>
                <button
                  type="button"
                  className="jm-audio-chip"
                  disabled={isProcessing}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDeriveNextAudio();
                  }}
                  title="创建下游连线音频节点，执行续写 / 翻唱 / 局部替换 / 裁剪变速"
                >
                  🔁 续写/变奏
                </button>
                <a
                  className="jm-audio-chip"
                  href={flowMusicDownloadUrl(activeClipId, "wav")}
                  download={`${displayTitle}.wav`}
                  onClick={(e) => e.stopPropagation()}
                  title="从 Flow Music 下载无损 WAV 母带"
                >
                  ⬇ WAV
                </a>
              </>
            ) : (
              <button
                type="button"
                className="jm-audio-chip"
                disabled={analyzing || isProcessing}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleAnalyzeUploadedAudio();
                }}
                title="使用 Flow Music 免费分析该参考音频的曲风与人声，解锁分轨与翻唱（0 积分）"
              >
                {analyzing ? "解析中…" : "✨ 解析曲风 (0分)"}
              </button>
            )}

            {data.musicLyrics && (
              <button
                type="button"
                className="jm-audio-chip"
                onClick={(e) => {
                  e.stopPropagation();
                  setLyricsExpanded((v) => !v);
                }}
              >
                {lyricsExpanded ? "收起歌词" : "📄 歌词"}
              </button>
            )}

            <button
              type="button"
              className="jm-audio-chip"
              onClick={(e) => {
                e.stopPropagation();
                handleSaveToLibrary();
              }}
              title="收藏至跨画布资产库"
            >
              {savedFlash ? "★ 已收藏" : "★ 收藏"}
            </button>
          </div>

          {/* 可折叠 4 轨分轨子抽屉 */}
          {hasStems && stemsExpanded && (
            <div className="jm-audio-stems nodrag" onClick={(e) => e.stopPropagation()}>
              {stemEntries.map(([stemKey, stemMid]) => {
                const meta = MUSIC_STEM_META[stemKey] ?? { label: stemKey, icon: "🎵" };
                const stemBgmActive = bgmMediaId === stemMid;
                return (
                  <div key={stemKey} className="jm-audio-stem-row">
                    <div className="jm-audio-stem-row__head">
                      <span>
                        {meta.icon} {meta.label}
                      </span>
                      <div className="jm-audio-stem-row__btns">
                        <button
                          type="button"
                          className={`jm-audio-mini-btn${stemBgmActive ? " jm-audio-mini-btn--active" : ""}`}
                          onClick={() => handleMountBgm(stemMid, `${displayTitle} · ${meta.label}`)}
                        >
                          {stemBgmActive ? "✓ BGM" : "设为 BGM"}
                        </button>
                        <a
                          className="jm-audio-mini-btn"
                          href={mediaUrl(stemMid)}
                          download={`${displayTitle}-${stemKey}.m4a`}
                        >
                          ⬇
                        </a>
                      </div>
                    </div>
                    <audio
                      className="jm-audio-stem-player"
                      src={mediaUrl(stemMid)}
                      controls
                      preload="none"
                    />
                  </div>
                );
              })}
              <button
                type="button"
                className="visual-asset__action jm-audio-stems__split-btn"
                disabled={splittingToNodes}
                onClick={() => void handleSpawnStemNodes()}
              >
                {splittingToNodes ? "正在拆分节点…" : "🧩 拆分为 4 个独立画布节点"}
              </button>
            </div>
          )}

          {/* 可折叠歌词预览 */}
          {lyricsExpanded && data.musicLyrics && (
            <pre className="jm-audio-lyrics nodrag" onClick={(e) => e.stopPropagation()}>
              {data.musicLyrics}
            </pre>
          )}
        </div>
      )}

      {data.aiBrief && (
        <p className="brief-hint" title={data.aiBrief}>
          ✨ {data.aiBrief}
        </p>
      )}
      {(localError || data.error) && (
        <p className="node-error" role="alert">
          {localError || data.error}
        </p>
      )}
    </div>
  );
}
