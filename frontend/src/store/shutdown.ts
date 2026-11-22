import { create } from "zustand";
import { shutdownService } from "../api/client";
import { useDesktopFlowStore } from "./desktopFlow";

export type ShutdownPhase = "idle" | "saving" | "stopping" | "completed";

interface ShutdownState {
  confirmOpen: boolean;
  phase: ShutdownPhase;
  openConfirm: () => void;
  closeConfirm: () => void;
  confirmAndShutdown: (isDesktop: boolean) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useShutdownStore = create<ShutdownState>((set, get) => ({
  confirmOpen: false,
  phase: "idle",

  openConfirm: () => {
    if (get().phase !== "idle") return;
    set({ confirmOpen: true });
  },

  closeConfirm: () => {
    if (get().phase !== "idle") return;
    set({ confirmOpen: false });
  },

  confirmAndShutdown: async (isDesktop: boolean) => {
    if (get().phase !== "idle") return;
    set({ confirmOpen: false, phase: "saving" });

    // Close inner Flow drawer cleanly if it was open on Desktop before shutter curtain descends
    if (isDesktop) {
      void useDesktopFlowStore.getState().closeDrawer().catch(() => {});
    }

    // Trigger backend graceful teardown; ignore connection reset if server exits quickly
    void shutdownService({
      defer_process_exit: isDesktop,
      stop_frontend: !isDesktop,
    }).catch(() => {});

    await sleep(650);
    set({ phase: "stopping" });

    await sleep(800);
    if (isDesktop) {
      try {
        await useDesktopFlowStore.getState().quitApp();
      } catch {
        // ignore if main process already exiting
      }
      set({ phase: "completed" });
    } else {
      set({ phase: "completed" });
    }
  },
}));
