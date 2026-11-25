import { extractErrorMessage } from "./client";

export type FlowPaygateTier = "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO";

export interface FlowAccount {
  id: string;
  label: string;
  google_email?: string | null;
  project_id: string | null;
  paygate_tier: FlowPaygateTier | null;
  paired?: boolean;
  connected: boolean;
  flow_tab_open: boolean;
  music_tab_open?: boolean;
  credits: number | null;
  credits_updated_at: string | null;
  music_credits?: number | null;
  music_plan?: string | null;
  music_credits_updated_at?: string | null;
}

export interface FlowAccountSnapshot {
  active_account_id: string | null;
  accounts: FlowAccount[];
  extension_path: string;
  embedded_browser?: boolean;
}

interface FlowAccountEdit {
  label?: string;
  project_id?: string | null;
  credits?: number | null;
  paygate_tier?: FlowPaygateTier | null;
}

async function request<T>(suffix = "", method = "GET", body?: FlowAccountEdit, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/flow-accounts${suffix}`, {
    method,
    cache: "no-store",
    signal,
    ...(method !== "GET" && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json() as Promise<T>;
}

export const getFlowAccounts = (signal?: AbortSignal) => request<FlowAccountSnapshot>("", "GET", undefined, signal);
export const createFlowAccount = (account: FlowAccountEdit & { label: string }) =>
  request<FlowAccountSnapshot & { created_account_id: string }>("", "POST", account);
export const editFlowAccount = (id: string, account: FlowAccountEdit) =>
  request<FlowAccountSnapshot>(`/${encodeURIComponent(id)}`, "PATCH", account);
export const activateFlowAccount = (id: string, opts?: { skipLaunch?: boolean }) =>
  request<FlowAccountSnapshot>(
    `/${encodeURIComponent(id)}/activate${opts?.skipLaunch ? "?skip_launch=true" : ""}`,
    "POST",
  );
export const pairFlowAccount = (id: string) =>
  request<{ code: string; expires_in: number }>(`/${encodeURIComponent(id)}/pair`, "POST");
export const syncFlowCredits = () =>
  request<FlowAccountSnapshot>("/sync-credits", "POST");

export const restoreLegacyFlow = () => request<FlowAccountSnapshot>("/legacy", "POST");

export interface GoogleFlowLoginConfig {
  configured: boolean;
  redirect_uri: string;
}

export type GoogleFlowLoginStatus =
  | { status: "pending" }
  | { status: "success"; account_id: string }
  | { status: "error"; detail?: string };

export const getGoogleFlowLoginConfig = (signal?: AbortSignal) =>
  request<GoogleFlowLoginConfig>("/google/config", "GET", undefined, signal);
export const startGoogleFlowLogin = (signal?: AbortSignal) =>
  request<{ authorization_url: string; attempt_id: string }>("/google/start", "POST", undefined, signal);
export const getGoogleFlowLoginStatus = (attemptId: string, signal?: AbortSignal) =>
  request<GoogleFlowLoginStatus>(`/google/status/${encodeURIComponent(attemptId)}`, "GET", undefined, signal);
