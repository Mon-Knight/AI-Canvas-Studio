import { contextBridge, ipcRenderer } from "electron";
import type {
  FlowEngineState,
  FlowViewBounds,
  OpenFlowDrawerOptions,
  PairResult,
  PickImagesOptions,
  PickImagesResult,
} from "../types";

// Keep channel literals self-contained so sandbox: true preload never requires local files.
const CHANNELS = {
  GET_STATE: "flowboard-desktop:get-state",
  STATE_CHANGED: "flowboard-desktop:state-changed",
  OPEN_DRAWER: "flowboard-desktop:open-drawer",
  CLOSE_DRAWER: "flowboard-desktop:close-drawer",
  SET_DRAWER_BOUNDS: "flowboard-desktop:set-drawer-bounds",
  RELOAD_FLOW: "flowboard-desktop:reload-flow",
  OPEN_STANDALONE_AUTH: "flowboard-desktop:open-standalone-auth",
  SYNC_ACCOUNTS_NOW: "flowboard-desktop:sync-accounts-now",
  PAIR_WITH_CODE: "flowboard-desktop:pair-with-code",
  PICK_IMAGES: "flowboard-desktop:pick-images",
  QUIT_APP: "flowboard-desktop:quit-app",
} as const;

contextBridge.exposeInMainWorld("flowboardDesktop", {
  getState(): Promise<FlowEngineState> {
    return ipcRenderer.invoke(CHANNELS.GET_STATE);
  },

  onStateChange(listener: (state: FlowEngineState) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, state: FlowEngineState) => {
      listener(state);
    };
    ipcRenderer.on(CHANNELS.STATE_CHANGED, wrapped);
    return () => {
      ipcRenderer.removeListener(CHANNELS.STATE_CHANGED, wrapped);
    };
  },

  openDrawer(opts?: OpenFlowDrawerOptions): Promise<FlowEngineState> {
    return ipcRenderer.invoke(CHANNELS.OPEN_DRAWER, opts);
  },

  closeDrawer(): Promise<FlowEngineState> {
    return ipcRenderer.invoke(CHANNELS.CLOSE_DRAWER);
  },

  setDrawerBounds(bounds: FlowViewBounds): Promise<void> {
    return ipcRenderer.invoke(CHANNELS.SET_DRAWER_BOUNDS, bounds);
  },

  reloadFlow(): Promise<void> {
    return ipcRenderer.invoke(CHANNELS.RELOAD_FLOW);
  },

  openStandaloneAuthWindow(): Promise<void> {
    return ipcRenderer.invoke(CHANNELS.OPEN_STANDALONE_AUTH);
  },

  syncAccountsNow(): Promise<FlowEngineState> {
    return ipcRenderer.invoke(CHANNELS.SYNC_ACCOUNTS_NOW);
  },

  pairWithCode(code: string): Promise<PairResult> {
    return ipcRenderer.invoke(CHANNELS.PAIR_WITH_CODE, code);
  },

  pickImages(opts?: PickImagesOptions): Promise<PickImagesResult> {
    return ipcRenderer.invoke(CHANNELS.PICK_IMAGES, opts);
  },

  quitApp(): Promise<void> {
    return ipcRenderer.invoke(CHANNELS.QUIT_APP);
  },
});
