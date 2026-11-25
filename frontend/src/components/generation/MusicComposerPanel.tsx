/**
 * Google Flow Music (Lyria 3.5 / Lyria 3 Pro · 个人独立音乐积分通道) 创作与衍生编辑面板。
 * - 支持在音频节点详细弹窗（GenerationDialog）与声画导演工作舱（AudioDirectorModal）中复用
 * - 遵循即梦深空纯黑灰毛玻璃风格，所有 AI 构思/作词结果均需人工审阅后再手动确认发起扣分生成
 */
import { useEffect, useMemo, useState } from "react";
import {
  composeMusicPrompt,
  connectFlowMusic,
  generateMusicLyrics,
  getMusicStatus,
  syncMusicCredits,
  type FlowMusicStatus,
} from "../../api/music";
import {
  MUSIC_DURATION_PRESETS,
  MUSIC_MODEL_CATALOG,
  estimateMusicCreditCost,
} from "../../constants/models";
import { displayNodeTitle } from "../../constants/nodeLabels";
import { useBoardStore } from "../../store/board";
import { useFlowAccounts } from "../../store/flowAccounts";
import { useGenerationStore } from "../../store/generation";
import { resolveOrderedTimelineShots, useTimelineAudioStore } from "../../store/timelineAudio";

export type MusicComposerMode = "create" | "extend" | "cover" | "replace" | "effect";

const MUSIC_GENRE_CHIPS: ReadonlyArray<{ label: string; snippet: string }> = [
  {
    label: "电影史诗弦乐",
    snippet: "宏大电影配乐，温暖大提琴铺底，铜管与交响弦乐渐强推进，宽广史诗空间感",
  },
  {
    label: "赛博霓虹电子",
    snippet: "赛博朋克合成器波，模拟低音律动与霓虹雨夜脉冲音色，现代都市未来感",
  },
  {
    label: "新中式国风",
    snippet: "东方国风意境，清越竹笛、古筝拨弦与柔和箫声，搭配轻盈现代电影鼓点",
  },
  {
    label: "Lo-Fi 治愈都市",
    snippet: "温暖 Lo-Fi 节奏，柔焦电钢和弦、细腻黑胶质感与舒缓都市咖啡馆氛围",
  },
  {
    label: "悬疑紧张脉冲",
    snippet: "悬疑心理惊悚配乐，低频脉冲合成器、轻敲金属打击乐与克制弦乐张力",
  },
  {
    label: "热血燃向摇滚",
    snippet: "高能流行摇滚，明快失真电吉他 Riff、紧凑实录鼓组与激昂副歌推进",
  },
];

interface MusicComposerPanelProps {
  /** 目标画布音频节点 ID；为空时（如声画导演页快捷创作）提交时自动创建新的音频节点 */
  rfId?: string | null;
  initialPrompt?: string;
  initialMode?: MusicComposerMode;
  /** true 时不渲染外层模态遮罩与标题栏，适合嵌入声画导演工作舱 */
  embedded?: boolean;
  onClose?: () => void;
  onDispatched?: (nodeRfId: string) => void;
}

export function MusicComposerPanel({
  rfId,
  initialPrompt = "",
  initialMode,
  embedded = false,
  onClose,
  onDispatched,
}: MusicComposerPanelProps) {
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const dispatchMusicGeneration = useGenerationStore((s) => s.dispatchMusicGeneration);
  const dispatchMusicEdit = useGenerationStore((s) => s.dispatchMusicEdit);
  const dispatchMusicEffect = useGenerationStore((s) => s.dispatchMusicEffect);
  const refreshFlowAccounts = useFlowAccounts((s) => s.refresh);
  const shotOverrides = useTimelineAudioStore((s) => s.shotOverrides);
  const customOrderKeys = useTimelineAudioStore((s) => s.customOrderKeys);

  const node = useMemo(
    () => (rfId ? nodes.find((n) => n.id === rfId) ?? null : null),
    [nodes, rfId],
  );

  // 收集上游连接节点或画布分镜上下文（按叙事位置排序，同时收集图片 mediaId 供视觉构思）
  const upstreamInfo = useMemo(() => {
    const typeLabel = (t: string): string => {
      if (t === "video") return "视频分镜";
      if (t === "character") return "角色卡";
      if (t === "subject") return "主体参考";
      if (t === "image") return "画面";
      if (t === "prompt") return "文本剧本";
      if (t === "note") return "便签";
      return "节点";
    };

    const formatNodeSummary = (n: (typeof nodes)[number]): string | null => {
      const label = displayNodeTitle(n.data.title, n.data.type);
      const brief = typeof n.data.aiBrief === "string" ? n.data.aiBrief.trim() : "";
      const p = typeof n.data.prompt === "string" ? n.data.prompt.trim() : "";
      const parts: string[] = [];
      if (brief) parts.push(`画面：${brief}`);
      if (p && p !== brief) parts.push(`描述：${p}`);
      if (parts.length === 0) return null;
      const dur =
        n.data.type === "video" && typeof n.data.durationSeconds === "number"
          ? ` · ${n.data.durationSeconds}秒`
          : "";
      return `[${typeLabel(n.data.type)}${dur}] ${label} — ${parts.join("；")}`;
    };

    const extractImageMediaIds = (list: typeof nodes): string[] => {
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const n of list) {
        if (ids.length >= 3) break;
        if (n.data.type === "video" || n.data.type === "audio" || n.data.type === "prompt" || n.data.type === "note") {
          continue;
        }
        const mid =
          (typeof n.data.mediaId === "string" && n.data.mediaId.trim()) ||
          (Array.isArray(n.data.mediaIds)
            ? n.data.mediaIds.find((x): x is string => typeof x === "string" && x.trim().length > 0)?.trim()
            : "") ||
          "";
        if (mid && !seen.has(mid)) {
          seen.add(mid);
          ids.push(mid);
        }
      }
      return ids;
    };

    const sortByReadingOrder = (list: typeof nodes) =>
      [...list].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);

    const boardSourceNodes = sortByReadingOrder(
      nodes.filter((n) => n.data.type !== "audio"),
    );

    if (!rfId) {
      const visualContext = boardSourceNodes
        .map(formatNodeSummary)
        .filter((s): s is string => Boolean(s))
        .slice(0, 10);
      return {
        audioNode: null,
        promptTexts: [] as string[],
        visualContext,
        visualMediaIds: extractImageMediaIds(boardSourceNodes),
      };
    }

    const incoming = sortByReadingOrder(
      edges
        .filter((e) => e.target === rfId)
        .map((e) => nodes.find((n) => n.id === e.source))
        .filter((n): n is NonNullable<typeof n> => Boolean(n)),
    );

    const audioNode =
      incoming.find((n) => n.data.type === "audio" && Boolean(n.data.musicClipId)) ?? null;
    const promptTexts = incoming
      .filter((n) => n.data.type === "prompt" && typeof n.data.prompt === "string" && n.data.prompt.trim())
      .map((n) => n.data.prompt!.trim());
    const incomingNonAudio = incoming.filter((n) => n.data.type !== "audio");
    const effectiveNodes = incomingNonAudio.length > 0 ? incomingNonAudio : boardSourceNodes;
    const visualContext = effectiveNodes
      .map(formatNodeSummary)
      .filter((s): s is string => Boolean(s))
      .slice(0, 10);
    const visualMediaIds = extractImageMediaIds(effectiveNodes);
    return { audioNode, promptTexts, visualContext, visualMediaIds };
  }, [rfId, nodes, edges]);

  const sourceClipId =
    upstreamInfo.audioNode?.data.musicClipId || node?.data.musicClipId || "";
  const sourceClipTitle = upstreamInfo.audioNode
    ? displayNodeTitle(upstreamInfo.audioNode.data.title, upstreamInfo.audioNode.data.type)
    : node?.data.musicClipId
      ? displayNodeTitle(node.data.title, node.data.type)
      : "";
  const hasSourceClip = Boolean(sourceClipId);

  const defaultMode: MusicComposerMode =
    initialMode ??
    (upstreamInfo.audioNode?.data.musicClipId && !node?.data.mediaId ? "extend" : "create");

  const [mode, setMode] = useState<MusicComposerMode>(defaultMode);
  const [title, setTitle] = useState(node?.data.musicTitle ?? "");
  const [prompt, setPrompt] = useState(initialPrompt || node?.data.prompt || "");
  const [instrumental, setInstrumental] = useState<boolean>(
    node?.data.musicInstrumental !== undefined ? Boolean(node.data.musicInstrumental) : true,
  );
  const [lyrics, setLyrics] = useState(node?.data.musicLyrics ?? "");
  const [musicModel, setMusicModel] = useState(node?.data.musicModel || MUSIC_MODEL_CATALOG[0].id);
  const [durationSec, setDurationSec] = useState<number>(node?.data.musicDurationSec ?? 90);
  const [bpmInput, setBpmInput] = useState<string>(
    typeof node?.data.musicBpm === "number" && node.data.musicBpm > 0
      ? String(node.data.musicBpm)
      : "",
  );
  const [seedInput, setSeedInput] = useState<string>("");

  // 衍生编辑参数
  const [extendFromSec, setExtendFromSec] = useState<string>("");
  const [extendSec, setExtendSec] = useState<number>(30);
  const [coverStrength, setCoverStrength] = useState<number>(0.6);
  const [replaceStartSec, setReplaceStartSec] = useState<number>(15);
  const [replaceEndSec, setReplaceEndSec] = useState<number>(30);

  // 0 积分裁剪 / 变速参数
  const [effectKind, setEffectKind] = useState<"trim" | "tempo">("trim");
  const [trimStartSec, setTrimStartSec] = useState<number>(0);
  const [trimEndSec, setTrimEndSec] = useState<number>(30);
  const [tempoSpeed, setTempoSpeed] = useState<number>(1.0);
  const [tempoSemitones, setTempoSemitones] = useState<number>(0);

  // Flow Music 个人通道状态与 AI 辅助状态
  const [status, setStatus] = useState<FlowMusicStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncingCredits, setSyncingCredits] = useState(false);
  const [lyricsBusy, setLyricsBusy] = useState(false);
  const [composeBusy, setComposeBusy] = useState(false);
  const [preAiPrompt, setPreAiPrompt] = useState<string | null>(null);
  const [preAiLyrics, setPreAiLyrics] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 拉取 Flow Music 状态
  useEffect(() => {
    let alive = true;
    setStatusLoading(true);
    void getMusicStatus(false)
      .then((res) => {
        if (!alive) return;
        setStatus(res);
        if (
          res.error &&
          (res.signed_in ||
            res.error.includes("chrome://extensions") ||
            res.error.includes("连接 Flow Music 失败"))
        ) {
          setError(res.error);
        }
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof Error ? err.message : "读取 Flow Music 状态失败");
        }
      })
      .finally(() => {
        if (alive) setStatusLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // ESC 关闭非嵌入弹窗
  useEffect(() => {
    if (embedded || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [embedded, onClose]);

  // 计算当前画布时间线预估总时长
  const estimatedTimelineSec = useMemo(() => {
    const rawVisual = nodes
      .filter(
        (n) =>
          n.data.type !== "prompt" &&
          n.data.type !== "note" &&
          n.data.type !== "audio" &&
          Boolean(n.data.mediaId || n.data.mediaIds?.some(Boolean)),
      )
      .map((n) => ({
        key: `${n.id}-0-${n.data.mediaId ?? n.data.mediaIds?.[0] ?? ""}`,
        kind: n.data.type === "video" ? "video" : "image",
        duration: typeof n.data.durationSeconds === "number" ? n.data.durationSeconds : 5,
      }));
    if (rawVisual.length === 0) return null;
    const ordered = resolveOrderedTimelineShots(rawVisual, customOrderKeys, shotOverrides, 3);
    const total = ordered
      .filter((entry) => !entry.excluded)
      .reduce(
        (sum, entry) =>
          sum + (entry.shot.kind === "video" ? entry.shot.duration : entry.imageDurationSec),
        0,
      );
    return total > 0 ? Math.min(180, Math.max(15, Math.round(total))) : null;
  }, [nodes, customOrderKeys, shotOverrides]);

  const creditEstimate = useMemo(() => {
    if (mode === "effect") return estimateMusicCreditCost("effect_music");
    if (mode === "create") return estimateMusicCreditCost("gen_music");
    return estimateMusicCreditCost("edit_music");
  }, [mode]);

  async function handleConnectFlowMusic() {
    if (connecting) return;
    setConnecting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await connectFlowMusic(true);
      const next = await getMusicStatus(true);
      setStatus(next);
      void refreshFlowAccounts();
      if (res.signed_in || next.signed_in) {
        setNotice(
          next.music_credits !== null
            ? `✓ Flow Music 个人通道已就绪，当前剩余 ${next.music_credits} 音乐积分。`
            : "✓ Flow Music 个人通道已就绪，可直接创作或刷新音乐积分。",
        );
      } else if (next.error && next.error.includes("chrome://extensions")) {
        setError(next.error);
      } else {
        setNotice("已在 Chrome 中打开 flowmusic.app，请使用 Google 账号登录后点击「刷新音乐积分」。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "开启 Flow Music 通道失败");
    } finally {
      setConnecting(false);
    }
  }

  async function handleSyncCredits() {
    if (syncingCredits) return;
    setSyncingCredits(true);
    setError(null);
    setNotice(null);
    try {
      const next = await syncMusicCredits();
      setStatus(next);
      void refreshFlowAccounts();
      if (next.signed_in) {
        if (next.music_credits !== null) {
          setNotice(
            `✓ 已同步最新音乐积分：${next.music_credits} 积分${next.music_plan ? `（${next.music_plan}）` : ""}`,
          );
        } else if (next.error) {
          setError(next.error);
        } else {
          setNotice("✓ 已验证 Flow Music 登录态。");
        }
      } else {
        setError(
          next.error || "尚未检测到 Flow Music 登录态，请先点击「开启 Flow Music 通道」并在浏览器登录。",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新音乐积分失败");
    } finally {
      setSyncingCredits(false);
    }
  }

  async function handleGenerateLyrics() {
    if (lyricsBusy) return;
    const seedPrompt =
      prompt.trim() ||
      title.trim() ||
      upstreamInfo.visualContext.slice(0, 3).join("；");
    if (!seedPrompt) {
      setError("请先在上方输入曲风或主题描述（或连接画布分镜），再使用 AI 作词。");
      return;
    }
    setLyricsBusy(true);
    setError(null);
    setNotice(null);
    try {
      setPreAiLyrics(lyrics);
      const res = await generateMusicLyrics(seedPrompt, {
        existingLyrics: lyrics.trim() || undefined,
        contextTexts: upstreamInfo.visualContext,
        targetDurationSec: durationSec,
        titleHint: title.trim() || undefined,
      });
      setInstrumental(false);
      if (res.lyrics) setLyrics(res.lyrics);
      if (res.title && !title.trim()) setTitle(res.title);
      setNotice(
        res.source === "llm"
          ? "✓ AI 已根据画面与曲风创作中文歌词（0 积分），请审阅或微调后再点击生成。"
          : "✓ AI 作词完成（0 积分），请审阅或编辑歌词后再点击生成。",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 作词失败");
    } finally {
      setLyricsBusy(false);
    }
  }

  async function handleComposeFromContext() {
    if (composeBusy) return;
    const contextTexts = upstreamInfo.visualContext;
    const mediaIds = upstreamInfo.visualMediaIds;

    if (contextTexts.length === 0 && mediaIds.length === 0 && !prompt.trim()) {
      setError("当前没有可供参考的上游分镜或画布画面，请先输入配乐风格描述。");
      return;
    }
    setComposeBusy(true);
    setError(null);
    setNotice(null);
    try {
      setPreAiPrompt(prompt);
      const res = await composeMusicPrompt({
        contextTexts,
        mediaIds,
        userHint: prompt.trim(),
        lyrics: !instrumental && lyrics.trim() ? lyrics.trim() : undefined,
        instrumental,
        targetDurationSec: estimatedTimelineSec ?? durationSec,
      });
      setPrompt(res.sound_prompt);
      if (res.suggested_bpm > 0) setBpmInput(String(res.suggested_bpm));
      if (res.suggested_title && !title.trim()) setTitle(res.suggested_title);
      setNotice(
        res.used_llm
          ? res.used_vision
            ? "✓ 已结合画布画面图像与分镜内容构思中文配乐词，请确认或微调后再手动点击生成（不会自动扣分）。"
            : "✓ 已结合画布分镜内容构思专业中文配乐词，请确认或微调后再手动点击生成（不会自动扣分）。"
          : "✓ 已按画布关键词整理出中文配乐草稿（在「设置 → AI 模型」中配置对话模型可启用更精准的看图编曲）。",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "构思配乐提示词失败");
    } finally {
      setComposeBusy(false);
    }
  }

  function appendGenreChip(snippet: string) {
    setPrompt((cur) => {
      const trimmed = cur.trim();
      if (!trimmed) return snippet;
      if (trimmed.includes(snippet)) return cur;
      return `${trimmed}，${snippet}`;
    });
  }

  async function handleSubmit() {
    if (submitting) return;
    setError(null);
    setNotice(null);

    if (mode !== "effect" && !prompt.trim()) {
      setError("请输入音乐风格、情绪或乐器描述。");
      return;
    }
    if (mode !== "create" && !sourceClipId) {
      setError("当前模式需要上游或本节点已有 Flow Music 生成的音频母带。");
      return;
    }

    setSubmitting(true);
    try {
      let targetRfId = rfId ?? null;
      if (!targetRfId) {
        const board = useBoardStore.getState();
        if (board.boardId === null) {
          setError("请先打开一个画布项目。");
          return;
        }
        const maxX = board.nodes.reduce((m, n) => Math.max(m, n.position.x + 280), 80);
        const created = await addNodeOfType("audio", { x: maxX + 80, y: 120 });
        if (!created) {
          setError("创建画布音频节点失败，请检查本地服务连接。");
          return;
        }
        targetRfId = created;
      }

      const parsedBpm = bpmInput.trim() ? parseInt(bpmInput.trim(), 10) : null;
      const parsedSeed = seedInput.trim() ? parseInt(seedInput.trim(), 10) : null;

      if (mode === "create") {
        await dispatchMusicGeneration(targetRfId, {
          prompt: prompt.trim(),
          lyrics: instrumental ? undefined : lyrics.trim() || undefined,
          instrumental,
          bpm: parsedBpm && Number.isFinite(parsedBpm) ? parsedBpm : null,
          durationSeconds: durationSec,
          musicModel,
          title: title.trim() || undefined,
          seed: parsedSeed !== null && Number.isFinite(parsedSeed) ? parsedSeed : null,
        });
      } else if (mode === "effect") {
        await dispatchMusicEffect(targetRfId, {
          sourceClipId,
          effect: effectKind,
          ...(effectKind === "trim"
            ? { startSec: trimStartSec, endSec: trimEndSec }
            : { speed: tempoSpeed, semitones: tempoSemitones }),
          title: title.trim() || undefined,
        });
      } else {
        const parsedExtendFrom = extendFromSec.trim() ? Number(extendFromSec.trim()) : null;
        await dispatchMusicEdit(targetRfId, {
          sourceClipId,
          action: mode,
          prompt: prompt.trim(),
          extendFromSec:
            mode === "extend" && parsedExtendFrom !== null && Number.isFinite(parsedExtendFrom)
              ? parsedExtendFrom
              : null,
          extendSec: mode === "extend" ? extendSec : undefined,
          coverStrength: mode === "cover" ? coverStrength : undefined,
          replaceStartSec: mode === "replace" ? replaceStartSec : undefined,
          replaceEndSec: mode === "replace" ? replaceEndSec : undefined,
          musicModel,
          title: title.trim() || undefined,
          seed: parsedSeed !== null && Number.isFinite(parsedSeed) ? parsedSeed : null,
        });
      }

      onDispatched?.(targetRfId);
      if (!embedded) {
        onClose?.();
      } else {
        setNotice("✓ 已提交至 Flow Music 个人通道生成队列，音频节点已加入画布，生成完成后可一键挂载为时间线 BGM。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交音乐任务失败");
    } finally {
      setSubmitting(false);
    }
  }

  const isBusy = node?.data.status === "queued" || node?.data.status === "running" || submitting;

  const content = (
    <div className="jm-music-composer">
      {/* 1. 个人 Flow Music 积分通道状态条 */}
      <div className="jm-music-status-bar">
        <div className="jm-music-status-bar__info">
          <span
            className={`jm-conn-dot jm-conn-dot--${
              status?.signed_in ? "ok" : status?.extension_connected ? "warn" : "off"
            }`}
            aria-hidden="true"
          />
          <span className="jm-music-status-bar__text">
            {statusLoading
              ? "正在检测 Flow Music 个人通道…"
              : status?.signed_in
                ? `Flow Music 个人通道已就绪${status.email ? ` · ${status.email}` : ""}`
                : status?.extension_connected
                  ? "未登录 Flow Music（请在 Chrome 登录 flowmusic.app）"
                  : "等待 Chrome 扩展连接"}
          </span>
          {status?.music_credits !== null && status?.music_credits !== undefined && (
            <span className="jm-music-credit-badge">
              🎵 {status.music_credits} 音乐积分
              {status.music_plan ? ` · ${status.music_plan}` : ""}
            </span>
          )}
        </div>
        <div className="jm-music-status-bar__actions">
          {!status?.signed_in && (
            <button
              type="button"
              className="jm-seq-ctrl-btn jm-seq-ctrl-btn--cyan"
              disabled={connecting}
              onClick={() => void handleConnectFlowMusic()}
            >
              {connecting ? "正在打开…" : "开启 Flow Music 通道"}
            </button>
          )}
          <button
            type="button"
            className="jm-seq-ctrl-btn"
            disabled={syncingCredits}
            onClick={() => void handleSyncCredits()}
          >
            {syncingCredits ? "刷新中…" : "刷新音乐积分"}
          </button>
        </div>
      </div>

      {/* 2. 创作 / 衍生编辑模式切换 */}
      <div className="jm-music-mode-tabs" role="tablist" aria-label="Flow Music 创作模式">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "create"}
          className={`aspect-chip${mode === "create" ? " aspect-chip--active" : ""}`}
          onClick={() => setMode("create")}
        >
          ✨ 创作新曲
        </button>
        {hasSourceClip && (
          <>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "extend"}
              className={`aspect-chip${mode === "extend" ? " aspect-chip--active" : ""}`}
              onClick={() => setMode("extend")}
            >
              🔁 续写 Extend
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "cover"}
              className={`aspect-chip${mode === "cover" ? " aspect-chip--active" : ""}`}
              onClick={() => setMode("cover")}
            >
              🎭 换风翻唱 Cover
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "replace"}
              className={`aspect-chip${mode === "replace" ? " aspect-chip--active" : ""}`}
              onClick={() => setMode("replace")}
            >
              ✂️ 局部替换
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "effect"}
              className={`aspect-chip${mode === "effect" ? " aspect-chip--active" : ""}`}
              onClick={() => setMode("effect")}
            >
              ⚡ 裁剪/变速 (0积分)
            </button>
          </>
        )}
      </div>

      {hasSourceClip && mode !== "create" && (
        <div className="jm-music-source-pill">
          <span>母带参考：{sourceClipTitle || "已选音频"}</span>
        </div>
      )}

      {/* 上游文本节点快捷导入 */}
      {upstreamInfo.promptTexts.length > 0 && mode !== "effect" && (
        <div className="jm-music-upstream-bar">
          <span className="gen-dialog__label">已连线上游文本：</span>
          <button
            type="button"
            className="jm-seq-ctrl-btn"
            onClick={() => setPrompt(upstreamInfo.promptTexts.join("\n"))}
          >
            填入曲风描述
          </button>
          <button
            type="button"
            className="jm-seq-ctrl-btn"
            onClick={() => {
              setInstrumental(false);
              setLyrics(upstreamInfo.promptTexts.join("\n"));
            }}
          >
            填入歌词正文
          </button>
        </div>
      )}

      {/* 3. 核心参数表单 */}
      {mode === "effect" ? (
        <div className="jm-music-effect-box">
          <div className="aspect-chip-row">
            <button
              type="button"
              className={`aspect-chip${effectKind === "trim" ? " aspect-chip--active" : ""}`}
              onClick={() => setEffectKind("trim")}
            >
              ✂️ 精准裁剪片段
            </button>
            <button
              type="button"
              className={`aspect-chip${effectKind === "tempo" ? " aspect-chip--active" : ""}`}
              onClick={() => setEffectKind("tempo")}
            >
              🎚️ 变速 / 升降调
            </button>
          </div>

          {effectKind === "trim" ? (
            <div className="jm-music-grid-2">
              <label className="gen-dialog__field">
                <span className="gen-dialog__label">起点时间（秒）</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  className="gen-dialog__seed-input"
                  value={trimStartSec}
                  onChange={(e) => setTrimStartSec(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <label className="gen-dialog__field">
                <span className="gen-dialog__label">终点时间（秒）</span>
                <input
                  type="number"
                  min={1}
                  step={0.5}
                  className="gen-dialog__seed-input"
                  value={trimEndSec}
                  onChange={(e) => setTrimEndSec(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
            </div>
          ) : (
            <div className="jm-music-grid-2">
              <label className="gen-dialog__field">
                <span className="gen-dialog__label">播放倍速：{tempoSpeed.toFixed(2)}x</span>
                <input
                  type="range"
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  value={tempoSpeed}
                  onChange={(e) => setTempoSpeed(Number(e.target.value))}
                />
              </label>
              <label className="gen-dialog__field">
                <span className="gen-dialog__label">
                  升降半音：{tempoSemitones > 0 ? `+${tempoSemitones}` : tempoSemitones} st
                </span>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={tempoSemitones}
                  onChange={(e) => setTempoSemitones(Number(e.target.value))}
                />
              </label>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="jm-music-grid-2">
            <label className="gen-dialog__field">
              <span className="gen-dialog__label">作品标题（可选）</span>
              <input
                type="text"
                className="gen-dialog__seed-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：霓虹雨夜 · 主题配乐"
              />
            </label>
            <div className="gen-dialog__field">
              <span className="gen-dialog__label">生成模型</span>
              <div className="aspect-chip-row">
                {MUSIC_MODEL_CATALOG.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`aspect-chip${musicModel === m.id ? " aspect-chip--active" : ""}`}
                    onClick={() => setMusicModel(m.id)}
                    title={m.summary}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="gen-dialog__field">
            <div className="jm-music-field-head">
              <span className="gen-dialog__label">
                {mode === "create"
                  ? "曲风、乐器与情绪描述"
                  : mode === "extend"
                    ? "续写段落情绪演变描述"
                    : mode === "cover"
                      ? "翻唱目标曲风与配器描述"
                      : "替换区间目标声音描述"}
              </span>
              <div className="jm-music-field-actions">
                {preAiPrompt !== null && (
                  <button
                    type="button"
                    className="jm-seq-ctrl-btn"
                    onClick={() => {
                      setPrompt(preAiPrompt);
                      setPreAiPrompt(null);
                      setNotice(null);
                    }}
                  >
                    ↩ 还原原词
                  </button>
                )}
                <button
                  type="button"
                  className="jm-seq-ctrl-btn jm-seq-ctrl-btn--cyan"
                  disabled={composeBusy}
                  onClick={() => void handleComposeFromContext()}
                  title="根据上游分镜/画布画面自动构思配乐描述，供人工确认后再生成"
                >
                  {composeBusy ? "构思中…" : "✨ 根据画面构思配乐词"}
                </button>
              </div>
            </div>
            <textarea
              className="gen-dialog__textarea"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例如：温暖电影弦乐配乐，钢琴前奏渐入大提琴与宽广弦乐高潮，雨夜霓虹治愈氛围…"
            />
            <div className="aspect-chip-row" style={{ flexWrap: "wrap", marginTop: 6 }}>
              {MUSIC_GENRE_CHIPS.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  className="aspect-chip"
                  onClick={() => appendGenreChip(chip.snippet)}
                >
                  + {chip.label}
                </button>
              ))}
            </div>
          </div>

          {/* 创作模式专属：人声/纯音乐 + 歌词 + 时长 + BPM */}
          {mode === "create" && (
            <>
              <div className="jm-music-grid-2">
                <div className="gen-dialog__field">
                  <span className="gen-dialog__label">人声形态</span>
                  <div className="aspect-chip-row">
                    <button
                      type="button"
                      className={`aspect-chip${instrumental ? " aspect-chip--active" : ""}`}
                      onClick={() => setInstrumental(true)}
                    >
                      🎹 纯音乐 BGM
                    </button>
                    <button
                      type="button"
                      className={`aspect-chip${!instrumental ? " aspect-chip--active" : ""}`}
                      onClick={() => setInstrumental(false)}
                    >
                      🎤 人声歌曲
                    </button>
                  </div>
                </div>

                <div className="gen-dialog__field">
                  <span className="gen-dialog__label">目标时长</span>
                  <div className="aspect-chip-row" style={{ flexWrap: "wrap" }}>
                    {MUSIC_DURATION_PRESETS.map((d) => (
                      <button
                        key={d.seconds}
                        type="button"
                        className={`aspect-chip${durationSec === d.seconds ? " aspect-chip--active" : ""}`}
                        onClick={() => setDurationSec(d.seconds)}
                      >
                        {d.label}
                      </button>
                    ))}
                    {estimatedTimelineSec && (
                      <button
                        type="button"
                        className="aspect-chip gen-dialog__preset-chip--active"
                        onClick={() => setDurationSec(estimatedTimelineSec)}
                        title="按当前画布镜头总时长自动对齐"
                      >
                        📏 对齐时间线 ({estimatedTimelineSec}s)
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {!instrumental && (
                <div className="gen-dialog__field">
                  <div className="jm-music-field-head">
                    <span className="gen-dialog__label">歌词正文（支持 [Verse] / [Chorus] 结构标签）</span>
                    <div className="jm-music-field-actions">
                      {preAiLyrics !== null && (
                        <button
                          type="button"
                          className="jm-seq-ctrl-btn"
                          onClick={() => {
                            setLyrics(preAiLyrics);
                            setPreAiLyrics(null);
                            setNotice(null);
                          }}
                        >
                          ↩ 还原原歌词
                        </button>
                      )}
                      <button
                        type="button"
                        className="jm-seq-ctrl-btn"
                        disabled={lyricsBusy}
                        onClick={() => void handleGenerateLyrics()}
                      >
                        {lyricsBusy ? "作词中…" : "✨ AI 作词 (0积分)"}
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="gen-dialog__textarea"
                    rows={4}
                    value={lyrics}
                    onChange={(e) => setLyrics(e.target.value)}
                    placeholder="[Verse 1]&#10;霓虹灯在雨里轻轻摇晃…&#10;&#10;[Chorus]&#10;穿过黑夜奔向天亮…"
                  />
                </div>
              )}

              <div className="jm-music-grid-2">
                <label className="gen-dialog__field">
                  <span className="gen-dialog__label">BPM 节拍（留空自动，40–220）</span>
                  <input
                    type="number"
                    min={40}
                    max={220}
                    className="gen-dialog__seed-input"
                    value={bpmInput}
                    onChange={(e) => setBpmInput(e.target.value)}
                    placeholder="自动"
                  />
                </label>
                <label className="gen-dialog__field">
                  <span className="gen-dialog__label">随机种子 Seed（可选）</span>
                  <input
                    type="number"
                    className="gen-dialog__seed-input"
                    value={seedInput}
                    onChange={(e) => setSeedInput(e.target.value)}
                    placeholder="留空随机"
                  />
                </label>
              </div>
            </>
          )}

          {/* 衍生编辑专属参数 */}
          {mode === "extend" && (
            <div className="jm-music-grid-2">
              <label className="gen-dialog__field">
                <span className="gen-dialog__label">从第几秒续写（留空从结尾续写）</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="gen-dialog__seed-input"
                  value={extendFromSec}
                  onChange={(e) => setExtendFromSec(e.target.value)}
                  placeholder="自动接在曲末"
                />
              </label>
              <label className="gen-dialog__field">
                <span className="gen-dialog__label">延长时长（秒）</span>
                <input
                  type="number"
                  min={5}
                  max={120}
                  className="gen-dialog__seed-input"
                  value={extendSec}
                  onChange={(e) => setExtendSec(Math.max(5, Number(e.target.value) || 30))}
                />
              </label>
            </div>
          )}

          {mode === "cover" && (
            <label className="gen-dialog__field">
              <span className="gen-dialog__label">
                曲风重塑强度：{Math.round(coverStrength * 100)}%（越低越贴近原曲旋律）
              </span>
              <input
                type="range"
                min={0.1}
                max={1.0}
                step={0.05}
                value={coverStrength}
                onChange={(e) => setCoverStrength(Number(e.target.value))}
              />
            </label>
          )}

          {mode === "replace" && (
            <div className="jm-music-grid-2">
              <label className="gen-dialog__field">
                <span className="gen-dialog__label">替换起始秒</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="gen-dialog__seed-input"
                  value={replaceStartSec}
                  onChange={(e) => setReplaceStartSec(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <label className="gen-dialog__field">
                <span className="gen-dialog__label">替换结束秒</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  className="gen-dialog__seed-input"
                  value={replaceEndSec}
                  onChange={(e) => setReplaceEndSec(Math.max(1, Number(e.target.value) || 15))}
                />
              </label>
            </div>
          )}
        </>
      )}

      {error && (
        <p className="visual-asset__error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="jm-audio-success-msg" role="status">
          {notice}
        </p>
      )}

      {/* 底部积分预估与确认生成 */}
      <div className="jm-music-footer">
        <span className="jm-music-footer__cost" title={creditEstimate.breakdown}>
          {creditEstimate.isZero ? "⚡ " : "✦ "}
          {creditEstimate.displayText}
        </span>
        <div className="jm-music-footer__btns">
          {!embedded && onClose && (
            <button type="button" className="jm-seq-ctrl-btn" onClick={onClose}>
              取消
            </button>
          )}
          <button
            type="button"
            className="gen-dialog__cta"
            disabled={isBusy}
            onClick={() => void handleSubmit()}
          >
            {isBusy
              ? "正在提交…"
              : mode === "create"
                ? "开始创作配乐 →"
                : mode === "effect"
                  ? "执行音频处理 →"
                  : "开始衍生编辑 →"}
          </button>
        </div>
      </div>
    </div>
  );

  if (embedded) return content;

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="gen-dialog jm-music-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Flow Music 音乐创作参数"
      >
        <div className="gen-dialog__header">
          <div>
            <h2 className="gen-dialog__title">
              🎵 {node ? displayNodeTitle(node.data.title, node.data.type) : "Flow Music 音乐创作"}
            </h2>
            <span className="gen-dialog__subtitle">
              基于个人 Flow Music 积分通道（Lyria 3.5 / Lyria 3 Pro），独立音乐积分池，不消耗视频积分
            </span>
          </div>
          <button
            type="button"
            className="gen-dialog__close"
            onClick={onClose}
            aria-label="关闭音乐创作参数"
          >
            ✕
          </button>
        </div>
        <div className="gen-dialog__body">{content}</div>
      </div>
    </div>
  );
}
