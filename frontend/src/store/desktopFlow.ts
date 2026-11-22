import { create } from "zustand";
import {
  isDesktopRuntime,
  type FlowEngineState,
  type FlowViewBounds,
  type OpenFlowDrawerOptions,
  type PairResult,
} from "../types/desktop";
import { useFlowAccounts } from "./flowAccounts";

interface DesktopFlowStore {
  isDesktop: boolean;
  state: FlowEngineState | null;
  init: () => () => void;
  openDrawer: (opts?: OpenFlowDrawerOptions) => Promise<void>;
  closeDrawer: () => Promise<void>;
  setDrawerBounds: (bounds: FlowViewBounds) => Promise<void>;
  reloadFlow: () => Promise<void>;
  openStandaloneAuthWindow: () => Promise<void>;
  syncAccountsNow: () => Promise<void>;
  pairWithCode: (code: string) => Promise<PairResult>;
  quitApp: () => Promise<void>;
}

export const useDesktopFlowStore = create<DesktopFlowStore>((set, get) => ({
  isDesktop: isDesktopRuntime(),
  state: null,

  init: () => {
    const bridge = typeof window !== "undefined" ? window.flowboardDesktop : undefined;
    if (!bridge) {
      set({ isDesktop: false, state: null });
      return () => {};
    }
    set({ isDesktop: true });

    let prevKey = "";
    const handleState = (next: FlowEngineState) => {
      const nextKey = `${next.activeAccountId}|${next.authState}|${next.paired}|${next.wsConnected}|${next.projectIdDetected}`;
      set({ isDesktop: true, state: next });
      if (nextKey !== prevKey) {
        prevKey = nextKey;
        void useFlowAccounts.getState().refresh();
      }
    };

    void bridge.getState().then(handleState).catch(() => {});
    const unsubscribe = bridge.onStateChange(handleState);
    return () => {
      unsubscribe();
    };
  },

  openDrawer: async (opts) => {
    const bridge = window.flowboardDesktop;
    if (!bridge) return;
    const next = await bridge.openDrawer(opts);
    set({ state: next });
  },

  closeDrawer: async () => {
    const bridge = window.flowboardDesktop;
    if (!bridge) return;
    await bridge.setDrawerBounds({ x: -10000, y: -10000, width: 1280, height: 800, visible: false });
    const next = await bridge.closeDrawer();
    set({ state: next });
  },

  setDrawerBounds: async (bounds) => {
    const bridge = window.flowboardDesktop;
    if (!bridge) return;
    await bridge.setDrawerBounds(bounds);
  },

  reloadFlow: async () => {
    const bridge = window.flowboardDesktop;
    if (!bridge) return;
    await bridge.reloadFlow();
    const s = get().state;
    if (s) void useFlowAccounts.getState().refresh();
  },

  openStandaloneAuthWindow: async () => {
    const bridge = window.flowboardDesktop;
    if (!bridge) return;
    await bridge.openStandaloneAuthWindow();
  },

  syncAccountsNow: async () => {
    const bridge = window.flowboardDesktop;
    if (!bridge) return;
    const next = await bridge.syncAccountsNow();
    set({ state: next });
    void useFlowAccounts.getState().refresh();
  },

  pairWithCode: async (code: string) => {
    const bridge = window.flowboardDesktop;
    if (!bridge) return { ok: false, error: "当前并非内嵌桌面模式。" };
    const result = await bridge.pairWithCode(code);
    if (result.ok) {
      const next = await bridge.getState();
      set({ state: next });
      void useFlowAccounts.getState().refresh();
    }
    return result;
  },

  quitApp: async () => {
    const bridge = window.flowboardDesktop;
    if (!bridge?.quitApp) return;
    await bridge.quitApp();
  },
}));
