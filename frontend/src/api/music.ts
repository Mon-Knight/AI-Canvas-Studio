import { api, extractErrorMessage } from "./client";

export interface MusicModelOption {
  id: string;
  label: string;
}

export interface FlowMusicStatus {
  account_id: string | null;
  extension_connected: boolean;
  music_tab_open: boolean;
  signed_in: boolean;
  email: string | null;
  music_credits: number | null;
  music_plan: string | null;
  music_credits_updated_at: string | null;
  models: MusicModelOption[];
  transport: string;
  error: string | null;
}

export interface FlowMusicConnectResult {
  ok: boolean;
  launched_via: string;
  music_tab_open: boolean;
  signed_in: boolean;
  email: string | null;
}

export interface FlowMusicLyricsResult {
  title: string;
  lyrics: string;
  lyrics_id: string;
  source?: "llm" | "flowmusic";
}

export interface FlowMusicAnalyzeResult {
  clip_id: string;
  audio_url: string;
  caption: string;
  lyrics: string;
}

export interface ComposeMusicPromptResult {
  sound_prompt: string;
  suggested_bpm: number;
  suggested_title: string;
  used_llm: boolean;
  used_vision?: boolean;
}

export interface AudioUploadResult {
  media_id: string;
  mime: string;
  size: number;
  filename: string;
}

export function getMusicStatus(refresh = false): Promise<FlowMusicStatus> {
  return api<FlowMusicStatus>(`/api/music/status${refresh ? "?refresh=true" : ""}`);
}

export function connectFlowMusic(active = true): Promise<FlowMusicConnectResult> {
  return api<FlowMusicConnectResult>("/api/music/connect", {
    method: "POST",
    body: JSON.stringify({ active }),
  });
}

export function syncMusicCredits(): Promise<FlowMusicStatus> {
  return api<FlowMusicStatus>("/api/music/sync-credits", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function generateMusicLyrics(
  prompt: string,
  opts?:
    | string
    | {
        lyricsId?: string;
        existingLyrics?: string;
        contextTexts?: string[];
        targetDurationSec?: number;
        titleHint?: string;
      },
): Promise<FlowMusicLyricsResult> {
  const options = typeof opts === "string" ? { lyricsId: opts } : opts ?? {};
  return api<FlowMusicLyricsResult>("/api/music/lyrics", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      ...(options.lyricsId ? { lyrics_id: options.lyricsId } : {}),
      ...(options.existingLyrics ? { existing_lyrics: options.existingLyrics } : {}),
      ...(options.contextTexts?.length ? { context_texts: options.contextTexts } : {}),
      ...(options.targetDurationSec ? { target_duration_s: options.targetDurationSec } : {}),
      ...(options.titleHint ? { title_hint: options.titleHint } : {}),
    }),
  });
}

export function analyzeCachedAudio(opts: {
  mediaId: string;
  nodeId?: number;
  removeVocals?: boolean;
}): Promise<FlowMusicAnalyzeResult> {
  return api<FlowMusicAnalyzeResult>("/api/music/analyze", {
    method: "POST",
    body: JSON.stringify({
      media_id: opts.mediaId,
      ...(opts.nodeId !== undefined ? { node_id: opts.nodeId } : {}),
      remove_vocals: Boolean(opts.removeVocals),
    }),
  });
}

export function composeMusicPrompt(opts: {
  contextTexts: string[];
  mediaIds?: string[];
  userHint?: string;
  lyrics?: string;
  instrumental: boolean;
  targetDurationSec?: number;
}): Promise<ComposeMusicPromptResult> {
  return api<ComposeMusicPromptResult>("/api/music/compose-prompt", {
    method: "POST",
    body: JSON.stringify({
      context_texts: opts.contextTexts,
      ...(opts.mediaIds?.length ? { media_ids: opts.mediaIds } : {}),
      user_hint: opts.userHint ?? "",
      ...(opts.lyrics ? { lyrics: opts.lyrics } : {}),
      instrumental: opts.instrumental,
      ...(opts.targetDurationSec ? { target_duration_s: opts.targetDurationSec } : {}),
    }),
  });
}

export async function uploadAudioFile(
  file: File,
  nodeId?: number,
): Promise<AudioUploadResult> {
  const form = new FormData();
  form.append("file", file);
  if (nodeId !== undefined) {
    form.append("node_id", String(nodeId));
  }
  const res = await fetch("/api/upload-audio", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<AudioUploadResult>;
}

export function flowMusicDownloadUrl(
  clipId: string,
  format: "wav" | "mp3" | "m4a" = "wav",
): string {
  return `/api/music/download/${encodeURIComponent(clipId)}?format=${format}`;
}
