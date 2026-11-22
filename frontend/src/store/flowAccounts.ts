import { create } from "zustand";
import { getFlowAccounts, syncFlowCredits, type FlowAccountSnapshot } from "../api/flowAccounts";
import { useGenerationStore } from "./generation";

interface FlowAccountsState {
  snapshot: FlowAccountSnapshot | null;
  readError: string | null;
  refresh: () => Promise<void>;
  syncCredits: () => Promise<void>;
  apply: (snapshot: FlowAccountSnapshot) => void;
}

let epoch = 0;
let inFlight: Promise<void> | null = null;
let creditsInFlight: Promise<void> | null = null;

export const useFlowAccounts = create<FlowAccountsState>((set, get) => ({
  snapshot: null,
  readError: null,
  refresh() {
    if (inFlight) return inFlight;
    const version = epoch;
    inFlight = getFlowAccounts()
      .then((snapshot) => {
        if (version === epoch) get().apply(snapshot);
      })
      .catch((err: unknown) => {
        if (version === epoch) set({ readError: err instanceof Error ? err.message : "读取失败" });
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  },
  syncCredits() {
    if (creditsInFlight) return creditsInFlight;
    const version = epoch;
    creditsInFlight = syncFlowCredits()
      .then((snapshot) => {
        if (version === epoch) get().apply(snapshot);
      })
      .catch(() => {})
      .finally(() => { creditsInFlight = null; });
    return creditsInFlight;
  },
  apply(snapshot) {
    ++epoch;
    const previous = get().snapshot;
    const activeId = snapshot.active_account_id;
    if (previous?.active_account_id !== activeId ||
        previous?.accounts.find((item) => item.id === activeId)?.project_id !==
          snapshot.accounts.find((item) => item.id === activeId)?.project_id) {
      useGenerationStore.setState({ projectId: null });
    }
    set({ snapshot, readError: null });
  },
}));
