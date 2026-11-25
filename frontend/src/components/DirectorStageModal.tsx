/**
 * 左栏「导演台」& `/` 技能中心弹出的 AI 导演编排工作舱（即梦深空毛玻璃居中浮窗）：
 * - Tab 1: 📜 AI 剧本拆分镜（输入中文故事 -> 生成分镜规划表 -> 人工编辑确认 -> 一键铺入画布）
 * - Tab 2: 🎬 爆款视频拉片复刻（本地上传参考短视频 -> 浏览器抽帧 -> 注册 Flow mediaId + 自动识别运镜 -> 一键搭好复刻流）
 */
import { useEffect, useRef, useState } from "react";
import {
  breakdownScript,
  createEdge,
  createNode,
  instantiateBoardRecipe,
  patchNode,
  uploadImage,
  type RecipeEdgeInput,
  type RecipeNodeInput,
  type ScriptBreakdownResponse,
} from "../api/client";
import { requestAutoBrief } from "../api/autoBrief";
import { analyzeCachedAudio, uploadAudioFile } from "../api/music";
import { useBoardStore, type FlowNode } from "../store/board";
import { useGenerationStore } from "../store/generation";

export type DirectorStageTab = "script" | "remake";

interface ExtractedFrame {
  index: number;
  timeSec: number;
  dataUrl: string;
  file: File;
}

async function extractVideoKeyframes(
  file: File,
  frameCount: number,
): Promise<{ frames: ExtractedFrame[]; duration: number; aspectRatio: string }> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("无法读取该视频格式，请尝试 MP4 或 WebM 文件"));
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 4;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const aspectRatio =
      vh > vw ? "IMAGE_ASPECT_RATIO_PORTRAIT" : "IMAGE_ASPECT_RATIO_LANDSCAPE";

    const maxW = 960;
    const scale = vw > maxW ? maxW / vw : 1;
    const cw = Math.max(64, Math.round(vw * scale));
    const ch = Math.max(64, Math.round(vh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("浏览器不支持 Canvas 视频抽帧");
    }

    const frames: ExtractedFrame[] = [];
    for (let i = 0; i < frameCount; i += 1) {
      const ratio = frameCount === 1 ? 0.5 : (i + 0.5) / frameCount;
      const targetTime = Math.min(Math.max(0.05, duration * ratio), Math.max(0.05, duration - 0.08));
      await new Promise<void>((resolve, reject) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          video.removeEventListener("error", onErr);
          resolve();
        };
        const onErr = () => {
          video.removeEventListener("seeked", onSeeked);
          video.removeEventListener("error", onErr);
          reject(new Error("视频抽帧定位失败"));
        };
        video.addEventListener("seeked", onSeeked);
        video.addEventListener("error", onErr);
        video.currentTime = targetTime;
      });
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(video, 0, 0, cw, ch);
      const dataUrl = canvas.toDataURL("image/png", 0.9);
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob((b) => res(b), "image/png", 0.92),
      );
      if (!blob) throw new Error("生成关键帧图片失败");
      frames.push({
        index: i + 1,
        timeSec: Number(targetTime.toFixed(1)),
        dataUrl,
        file: new File([blob], `remake-frame-${i + 1}.png`, { type: "image/png" }),
      });
    }
    return { frames, duration, aspectRatio };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function DirectorStageModal() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DirectorStageTab>("script");

  // ── Script breakdown state ──
  const [scriptText, setScriptText] = useState("");
  const [shotCount, setShotCount] = useState(4);
  const [aspectRatio, setAspectRatio] = useState("IMAGE_ASPECT_RATIO_LANDSCAPE");
  const [appendMusicNode, setAppendMusicNode] = useState(true);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ScriptBreakdownResponse | null>(null);
  const [placingScript, setPlacingScript] = useState(false);

  // ── Video remake state ──
  const [remakeFrames, setRemakeFrames] = useState<ExtractedFrame[]>([]);
  const [remakeCount, setRemakeCount] = useState(4);
  const [remakeAspect, setRemakeAspect] = useState("IMAGE_ASPECT_RATIO_LANDSCAPE");
  const [remakeCharacterPrompt, setRemakeCharacterPrompt] = useState(
    "高还原度全新主角设定：保留参考原片节奏与构图，替换为主角服装与五官特征",
  );
  const [remakeAudioFile, setRemakeAudioFile] = useState<File | null>(null);
  const [analyzeRemakeAudio, setAnalyzeRemakeAudio] = useState(true);
  const [extractBusy, setExtractBusy] = useState(false);
  const [remakeBusy, setRemakeBusy] = useState(false);
  const [remakeProgress, setRemakeProgress] = useState<string | null>(null);
  const [remakeError, setRemakeError] = useState<string | null>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const remakeAudioInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e instanceof CustomEvent ? e.detail : null) as {
        tab?: DirectorStageTab;
      } | null;
      if (detail?.tab === "remake" || detail?.tab === "script") {
        setTab(detail.tab);
      }
      setOpen(true);
    };
    window.addEventListener("flowboard:open-director-stage", onOpen);
    return () => window.removeEventListener("flowboard:open-director-stage", onOpen);
  }, []);

  if (!open) return null;

  async function handleGenerateBreakdown() {
    if (!scriptText.trim() || planBusy) return;
    setPlanError(null);
    setPlanBusy(true);
    try {
      const res = await breakdownScript({
        script: scriptText.trim(),
        shot_count: shotCount,
        aspect_ratio: aspectRatio,
      });
      setPlan(res);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "剧本拆解失败");
    } finally {
      setPlanBusy(false);
    }
  }

  async function handleApplyScriptPlan() {
    if (!plan || placingScript) return;
    const { boardId, nodes, boardName } = useBoardStore.getState();
    if (boardId === null) {
      setPlanError("请先打开一个画布项目");
      return;
    }
    setPlacingScript(true);
    setPlanError(null);
    try {
      const cleanName = boardName.trim();
      const isBlank =
        nodes.length === 0 &&
        (cleanName === "" || cleanName === "未命名项目" || cleanName === "Untitled");
      const groupId = `grp_${Date.now().toString(36)}`;
      const groupTitle = plan.title || "剧本分镜组";

      const recipeNodes: RecipeNodeInput[] = [
        {
          key: "subject",
          type: "character",
          x: 60,
          y: Math.max(80, Math.round((plan.shots.length - 1) * 140)),
          data: {
            title: "主角统一设定",
            prompt: plan.character_prompt,
            aspectRatio,
            groupId,
            groupTitle,
          },
        },
      ];
      const recipeEdges: RecipeEdgeInput[] = [];
      const videoAspect = aspectRatio.includes("PORTRAIT")
        ? "VIDEO_ASPECT_RATIO_PORTRAIT"
        : "VIDEO_ASPECT_RATIO_LANDSCAPE";

      plan.shots.forEach((shot, i) => {
        const y = 60 + i * 280;
        const imgKey = `shot_img_${i + 1}`;
        const vidKey = `shot_vid_${i + 1}`;
        recipeNodes.push({
          key: imgKey,
          type: "image",
          x: 420,
          y,
          data: {
            title: `${shot.title} · 画面`,
            prompt: shot.image_prompt,
            aspectRatio,
            groupId,
            groupTitle,
          },
        });
        recipeNodes.push({
          key: vidKey,
          type: "video",
          x: 780,
          y,
          data: {
            title: `${shot.title} · 动态`,
            prompt: `${shot.video_prompt}（运镜：${shot.camera}）`,
            aspectRatio: videoAspect,
            cameraPreset: shot.camera,
            groupId,
            groupTitle,
          },
        });
        recipeEdges.push({ source_key: "subject", target_key: imgKey });
        recipeEdges.push({ source_key: imgKey, target_key: vidKey });
      });

      if (appendMusicNode) {
        const moodSummary = [
          plan.title ? `主题：${plan.title}` : "",
          scriptText.trim().slice(0, 140),
        ]
          .filter(Boolean)
          .join("；");
        recipeNodes.push({
          key: "theme_bgm",
          type: "audio",
          x: 1140,
          y: Math.max(80, Math.round((plan.shots.length - 1) * 140)),
          data: {
            title: `${groupTitle} · 主题配乐`,
            musicTitle: `${groupTitle} · 主题配乐`,
            prompt: `电影级原声配乐（纯音乐 BGM），情绪贴合剧本：${moodSummary}`,
            musicInstrumental: true,
            musicDurationSec: Math.min(180, Math.max(30, plan.shots.length * 10)),
            musicModel: "Lyria 3.5",
            groupId,
            groupTitle,
          },
        });
        if (plan.shots.length > 0) {
          recipeEdges.push({ source_key: "shot_vid_1", target_key: "theme_bgm" });
        }
      }

      await instantiateBoardRecipe({
        name: groupTitle,
        nodes: recipeNodes,
        edges: recipeEdges,
        target_board_id: isBlank ? boardId : undefined,
        append_to_board_id: isBlank ? undefined : boardId,
      });
      await useBoardStore.getState().refreshBoardState();
      setOpen(false);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "铺入画布失败");
    } finally {
      setPlacingScript(false);
    }
  }

  async function handlePickRemakeVideo(file: File) {
    setRemakeError(null);
    setExtractBusy(true);
    try {
      const res = await extractVideoKeyframes(file, remakeCount);
      setRemakeFrames(res.frames);
      setRemakeAspect(res.aspectRatio);
    } catch (err) {
      setRemakeError(err instanceof Error ? err.message : "抽帧失败");
    } finally {
      setExtractBusy(false);
    }
  }

  async function handleBuildRemakeWorkflow() {
    const boardId = useBoardStore.getState().boardId;
    if (boardId === null || remakeFrames.length === 0 || remakeBusy) return;
    setRemakeError(null);
    setRemakeBusy(true);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding?.flow_project_id) {
        setRemakeError("请先在右上角绑定 Flow 项目，再执行拉片关键帧上传。");
        return;
      }

      const nodesState = useBoardStore.getState().nodes;
      const baseX =
        nodesState.length > 0
          ? Math.max(...nodesState.map((n) => n.position.x + 280)) + 120
          : 60;
      const groupId = `grp_${Date.now().toString(36)}`;
      const groupTitle = "爆款拉片复刻组";
      const videoAspect = remakeAspect.includes("PORTRAIT")
        ? "VIDEO_ASPECT_RATIO_PORTRAIT"
        : "VIDEO_ASPECT_RATIO_LANDSCAPE";

      // 1. 新主角替换主体节点
      const charDto = await createNode({
        board_id: boardId,
        type: "character",
        x: Math.round(baseX),
        y: Math.round(Math.max(80, (remakeFrames.length - 1) * 140)),
        data: {
          title: "复刻主角设定",
          prompt: remakeCharacterPrompt,
          aspectRatio: remakeAspect,
          groupId,
          groupTitle,
        },
      });
      const addedNodes: FlowNode[] = [
        {
          id: String(charDto.id),
          type: "character",
          position: { x: charDto.x, y: charDto.y },
          data: {
            type: "character",
            shortId: charDto.short_id,
            title: "复刻主角设定",
            prompt: remakeCharacterPrompt,
            aspectRatio: remakeAspect,
            status: "idle",
            groupId,
            groupTitle,
          },
        },
      ];
      const addedEdges: ReturnType<typeof useBoardStore.getState>["edges"] = [];
      const nowIso = new Date().toISOString();

      // 2. 逐帧上传至 Flow (maseQ) -> 触发 /api/vision/describe -> 创建下游复刻生图与视频节点
      for (let i = 0; i < remakeFrames.length; i += 1) {
        const frame = remakeFrames[i];
        setRemakeProgress(`正在上传关键帧到 Flow (${i + 1}/${remakeFrames.length})…`);
        const y = Math.round(60 + i * 280);
        const refDto = await createNode({
          board_id: boardId,
          type: "visual_asset",
          x: Math.round(baseX + 340),
          y,
          data: {
            title: `原片第 ${frame.index} 帧 (${frame.timeSec}s)`,
            aspectRatio: remakeAspect,
            groupId,
            groupTitle,
          },
        });
        const up = await uploadImage(
          frame.file,
          binding.flow_project_id,
          refDto.id,
          binding.flow_account_id,
        );
        const refAspect = up.aspect_ratio || remakeAspect;
        await patchNode(refDto.id, {
          status: "done",
          data: {
            mediaId: up.media_id,
            mediaIds: [up.media_id],
            variantCount: 1,
            aspectRatio: refAspect,
            renderedAt: nowIso,
          },
        }).catch(() => {});

        const shotPrompt = `严格参考 ref_image_2 的原片构图、景别透视与光影节奏，将主体替换为 ref_image_1 中的全新主角（第 ${frame.index} 镜 · ${frame.timeSec}s）`;
        const imgDto = await createNode({
          board_id: boardId,
          type: "image",
          x: Math.round(baseX + 680),
          y,
          data: {
            title: `复刻分镜 #${frame.index}`,
            prompt: shotPrompt,
            aspectRatio: refAspect,
            groupId,
            groupTitle,
          },
        });
        const vidDto = await createNode({
          board_id: boardId,
          type: "video",
          x: Math.round(baseX + 1020),
          y,
          data: {
            title: `复刻视频 #${frame.index}`,
            prompt: `复刻原片第 ${frame.index} 镜动态节奏与镜头运镜，动作连贯丝滑`,
            aspectRatio: videoAspect,
            groupId,
            groupTitle,
          },
        });

        for (const [src, dst] of [
          [charDto.id, imgDto.id],
          [refDto.id, imgDto.id],
          [imgDto.id, vidDto.id],
        ]) {
          const eDto = await createEdge({
            board_id: boardId,
            source_id: src,
            target_id: dst,
          });
          addedEdges.push({
            id: String(eDto.id),
            source: String(eDto.source_id),
            target: String(eDto.target_id),
            data: { sourceVariantIdx: null },
          });
        }

        addedNodes.push(
          {
            id: String(refDto.id),
            type: "visual_asset",
            position: { x: refDto.x, y: refDto.y },
            data: {
              type: "visual_asset",
              shortId: refDto.short_id,
              title: `原片第 ${frame.index} 帧 (${frame.timeSec}s)`,
              status: "done",
              mediaId: up.media_id,
              mediaIds: [up.media_id],
              variantCount: 1,
              aspectRatio: refAspect,
              renderedAt: nowIso,
              groupId,
              groupTitle,
            },
          },
          {
            id: String(imgDto.id),
            type: "image",
            position: { x: imgDto.x, y: imgDto.y },
            data: {
              type: "image",
              shortId: imgDto.short_id,
              title: `复刻分镜 #${frame.index}`,
              prompt: shotPrompt,
              aspectRatio: refAspect,
              status: "idle",
              groupId,
              groupTitle,
            },
          },
          {
            id: String(vidDto.id),
            type: "video",
            position: { x: vidDto.x, y: vidDto.y },
            data: {
              type: "video",
              shortId: vidDto.short_id,
              title: `复刻视频 #${frame.index}`,
              prompt: `复刻原片第 ${frame.index} 镜动态节奏与镜头运镜，动作连贯丝滑`,
              aspectRatio: videoAspect,
              status: "idle",
              groupId,
              groupTitle,
            },
          },
        );
        requestAutoBrief(String(refDto.id), up.media_id);
      }

      // 3. 可选：上传原片参考音轨并调用 0 积分 Flow Music 解析曲风（解锁换风翻唱/分轨）
      if (remakeAudioFile) {
        setRemakeProgress("正在上传参考音轨并解析曲风（0 积分）…");
        const audioTitle = remakeAudioFile.name.replace(/\.[^.]+$/, "") || "原片参考音轨";
        const audioDto = await createNode({
          board_id: boardId,
          type: "audio",
          x: Math.round(baseX + 1360),
          y: Math.round(Math.max(80, (remakeFrames.length - 1) * 140)),
          data: {
            title: `${audioTitle} · 参考音轨`,
            musicTitle: `${audioTitle} · 参考音轨`,
            groupId,
            groupTitle,
          },
        });
        const uploadedAudio = await uploadAudioFile(remakeAudioFile, audioDto.id);
        let clipId: string | undefined;
        let caption: string | undefined;
        let lyrics: string | undefined;
        if (analyzeRemakeAudio) {
          try {
            const analyzed = await analyzeCachedAudio({
              mediaId: uploadedAudio.media_id,
              nodeId: audioDto.id,
            });
            clipId = analyzed.clip_id || undefined;
            caption = analyzed.caption || undefined;
            lyrics = analyzed.lyrics || undefined;
          } catch {
            // 若用户未登录 Flow Music，仍保留已上传的本地音频节点
          }
        }
        await patchNode(audioDto.id, {
          status: "done",
          data: {
            mediaId: uploadedAudio.media_id,
            mediaIds: [uploadedAudio.media_id],
            variantCount: 1,
            renderedAt: nowIso,
            ...(clipId ? { musicClipId: clipId, musicClipIds: [clipId] } : {}),
            ...(caption ? { aiBrief: caption, prompt: caption } : {}),
            ...(lyrics ? { musicLyrics: lyrics } : {}),
          },
        }).catch(() => {});

        addedNodes.push({
          id: String(audioDto.id),
          type: "audio",
          position: { x: audioDto.x, y: audioDto.y },
          data: {
            type: "audio",
            shortId: audioDto.short_id,
            title: `${audioTitle} · 参考音轨`,
            musicTitle: `${audioTitle} · 参考音轨`,
            status: "done",
            mediaId: uploadedAudio.media_id,
            mediaIds: [uploadedAudio.media_id],
            variantCount: 1,
            renderedAt: nowIso,
            ...(clipId ? { musicClipId: clipId, musicClipIds: [clipId] } : {}),
            ...(caption ? { aiBrief: caption, prompt: caption } : {}),
            ...(lyrics ? { musicLyrics: lyrics } : {}),
            groupId,
            groupTitle,
          },
        });
      }

      useBoardStore.setState((s) => ({
        nodes: [...s.nodes, ...addedNodes],
        edges: [...s.edges, ...addedEdges],
      }));
      setOpen(false);
    } catch (err) {
      setRemakeError(err instanceof Error ? err.message : "搭建拉片复刻工作流失败");
    } finally {
      setRemakeBusy(false);
      setRemakeProgress(null);
    }
  }

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="gen-dialog jm-director-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI 导演台"
      >
        <div className="gen-dialog__header">
          <div>
            <h2 className="gen-dialog__title">AI 导演台 · 脚本拆镜与爆款拉片</h2>
            <span className="gen-dialog__subtitle">
              先规划确认分镜结构，再一键生成标准 Flow 联动工作流
            </span>
          </div>
          <button
            type="button"
            className="gen-dialog__close"
            onClick={() => setOpen(false)}
            aria-label="关闭导演台"
          >
            ✕
          </button>
        </div>

        <div className="jm-director-modal__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "script"}
            className={`aspect-chip${tab === "script" ? " aspect-chip--active" : ""}`}
            onClick={() => setTab("script")}
          >
            📜 AI 剧本拆分镜
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "remake"}
            className={`aspect-chip${tab === "remake" ? " aspect-chip--active" : ""}`}
            onClick={() => setTab("remake")}
          >
            🎬 爆款视频拉片复刻
          </button>
        </div>

        <div className="gen-dialog__body">
          {tab === "script" ? (
            <>
              <div className="gen-dialog__field">
                <span className="gen-dialog__label">创意故事或商品脚本</span>
                <textarea
                  className="gen-dialog__textarea"
                  rows={4}
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  placeholder="输入故事大纲或分镜脚本（例如：暴雨夜霓虹街头，女侦探撑透明雨伞走进老旧咖啡馆，推门铃响，吧台后神秘人抬头递出一张旧照片）…"
                />
              </div>

              <div className="jm-director-modal__controls">
                <div className="aspect-chip-row">
                  <span className="gen-dialog__label" style={{ marginRight: 4 }}>分镜数</span>
                  {[3, 4, 6].map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      className={`aspect-chip${shotCount === cnt ? " aspect-chip--active" : ""}`}
                      onClick={() => setShotCount(cnt)}
                    >
                      {cnt} 镜
                    </button>
                  ))}
                </div>
                <div className="aspect-chip-row">
                  <button
                    type="button"
                    className={`aspect-chip${aspectRatio === "IMAGE_ASPECT_RATIO_LANDSCAPE" ? " aspect-chip--active" : ""}`}
                    onClick={() => setAspectRatio("IMAGE_ASPECT_RATIO_LANDSCAPE")}
                  >
                    16:9 横屏
                  </button>
                  <button
                    type="button"
                    className={`aspect-chip${aspectRatio === "IMAGE_ASPECT_RATIO_PORTRAIT" ? " aspect-chip--active" : ""}`}
                    onClick={() => setAspectRatio("IMAGE_ASPECT_RATIO_PORTRAIT")}
                  >
                    9:16 竖屏
                  </button>
                </div>
                <button
                  type="button"
                  className="gen-dialog__cta"
                  disabled={!scriptText.trim() || planBusy}
                  onClick={() => void handleGenerateBreakdown()}
                >
                  {planBusy ? "正在拆解脚本…" : "生成分镜方案 ✨"}
                </button>
              </div>

              <label className="jm-audio-toggle-row" style={{ marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={appendMusicNode}
                  onChange={(e) => setAppendMusicNode(e.target.checked)}
                />
                <span>🎵 同步在分镜组末端追加 Flow Music 主题配乐节点（预填氛围词，待人工确认后再扣分生成）</span>
              </label>

              {planError && <p className="visual-asset__error" role="alert">{planError}</p>}

              {plan && (
                <div className="jm-director-preview">
                  <div className="gen-dialog__field">
                    <span className="gen-dialog__label">
                      统一主角设定（{plan.source === "llm" ? "AI 智能拆解" : "离线快速分镜"} · 可直接微调）
                    </span>
                    <textarea
                      className="gen-dialog__textarea"
                      rows={2}
                      value={plan.character_prompt}
                      onChange={(e) =>
                        setPlan({ ...plan, character_prompt: e.target.value })
                      }
                    />
                  </div>
                  <div className="jm-director-shots">
                    {plan.shots.map((shot, i) => (
                      <div key={i} className="jm-director-shot-card">
                        <div className="jm-director-shot-card__head">
                          <strong>{shot.title}</strong>
                          <span className="jm-context-generator__badge">{shot.camera}</span>
                        </div>
                        <textarea
                          className="gen-dialog__textarea"
                          rows={2}
                          value={shot.image_prompt}
                          onChange={(e) => {
                            const next = [...plan.shots];
                            next[i] = { ...shot, image_prompt: e.target.value };
                            setPlan({ ...plan, shots: next });
                          }}
                        />
                        <input
                          type="text"
                          className="gen-dialog__seed-input"
                          value={shot.video_prompt}
                          onChange={(e) => {
                            const next = [...plan.shots];
                            next[i] = { ...shot, video_prompt: e.target.value };
                            setPlan({ ...plan, shots: next });
                          }}
                          aria-label={`${shot.title} 视频动作提示词`}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="jm-director-modal__controls">
                <div className="aspect-chip-row">
                  <span className="gen-dialog__label" style={{ marginRight: 4 }}>抽帧密度</span>
                  {[4, 6].map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      className={`aspect-chip${remakeCount === cnt ? " aspect-chip--active" : ""}`}
                      onClick={() => setRemakeCount(cnt)}
                    >
                      {cnt} 个关键镜
                    </button>
                  ))}
                </div>
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/mp4,video/webm,video/*"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void handlePickRemakeVideo(f);
                  }}
                />
                <button
                  type="button"
                  className="gen-dialog__cta"
                  disabled={extractBusy}
                  onClick={() => videoInputRef.current?.click()}
                >
                  {extractBusy ? "正在解析抽帧…" : "选择本地参考短视频 (.mp4/.webm)"}
                </button>
              </div>

              {/* 可选：同步挂载原片参考音轨（0 积分 Flow Music 解析曲风） */}
              <div className="jm-director-modal__controls" style={{ marginTop: 4 }}>
                <input
                  ref={remakeAudioInputRef}
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    e.target.value = "";
                    setRemakeAudioFile(f);
                  }}
                />
                <button
                  type="button"
                  className="jm-seq-ctrl-btn"
                  onClick={() => remakeAudioInputRef.current?.click()}
                >
                  🎵 {remakeAudioFile ? `已选参考音轨：${remakeAudioFile.name.slice(0, 18)}` : "附加原片参考音轨（可选）"}
                </button>
                {remakeAudioFile && (
                  <>
                    <label className="jm-audio-toggle-row" style={{ margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={analyzeRemakeAudio}
                        onChange={(e) => setAnalyzeRemakeAudio(e.target.checked)}
                      />
                      <span>自动调用 Flow Music 免费解析曲风 (0 积分)</span>
                    </label>
                    <button
                      type="button"
                      className="jm-seq-ctrl-btn"
                      onClick={() => setRemakeAudioFile(null)}
                    >
                      移除
                    </button>
                  </>
                )}
              </div>

              {remakeError && <p className="visual-asset__error" role="alert">{remakeError}</p>}
              {remakeProgress && (
                <p className="gen-dialog__hint" role="status">{remakeProgress}</p>
              )}

              <div className="gen-dialog__field">
                <span className="gen-dialog__label">替换后的新主角设定提示词</span>
                <textarea
                  className="gen-dialog__textarea"
                  rows={2}
                  value={remakeCharacterPrompt}
                  onChange={(e) => setRemakeCharacterPrompt(e.target.value)}
                />
              </div>

              {remakeFrames.length > 0 && (
                <div className="jm-remake-frames">
                  {remakeFrames.map((fr) => (
                    <div key={fr.index} className="jm-remake-frame">
                      <img src={fr.dataUrl} alt={`第 ${fr.index} 帧`} />
                      <span>第 {fr.index} 镜 · {fr.timeSec}s</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="gen-dialog__footer">
          <span className="gen-dialog__board-ctx">
            {tab === "script"
              ? appendMusicNode
                ? "将创建「主角设定 → 分镜画面 → 动态视频 + 主题配乐」联动分镜组"
                : "将创建「主角设定 → 分镜画面 → 动态视频」联动分镜组"
              : "所有抽帧均注册为 Flow 官方 mediaId（0 积分），铺流后可自由抽卡替换"}
          </span>
          {tab === "script" ? (
            <button
              type="button"
              className="gen-dialog__cta"
              disabled={!plan || placingScript}
              onClick={() => void handleApplyScriptPlan()}
            >
              {placingScript ? "正在铺入画布…" : "确认铺入画布 →"}
            </button>
          ) : (
            <button
              type="button"
              className="gen-dialog__cta"
              disabled={remakeFrames.length === 0 || remakeBusy}
              onClick={() => void handleBuildRemakeWorkflow()}
            >
              {remakeBusy ? "正在上传并搭流…" : "一键上传并搭建复刻流 →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
