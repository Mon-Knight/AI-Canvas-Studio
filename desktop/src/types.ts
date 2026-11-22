export type FlowEngineAuthState =
  | "idle"
  | "booting"
  | "login_required"
  | "authenticated"
  | "error";

export type FlowDrawerMode = "auto-onboarding" | "manual-inspect";

export interface FlowEngineMetrics {
  requestCount: number;
  successCount: number;
  failedCount: number;
  lastError: string | null;
}

export interface FlowEngineState {
  isEmbeddedRuntime: true;
  managedChromeMode?: boolean;
  extensionPath?: string;
  activeAccountId: string | null;
  authState: FlowEngineAuthState;
  currentUrl: string;
  projectIdDetected: string | null;
  paired: boolean;
  wsConnected: boolean;
  drawerOpen: boolean;
  drawerMode: FlowDrawerMode;
  standaloneWindowOpen: boolean;
  lastError: string | null;
  notice: string | null;
  metrics: FlowEngineMetrics;
}

export interface FlowViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface OpenFlowDrawerOptions {
  accountId?: string;
  mode?: FlowDrawerMode;
  url?: string;
}

export interface PairResult {
  ok: boolean;
  error?: string;
}

export interface PickedImageFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface PickImagesOptions {
  multiple?: boolean;
  title?: string;
}

export interface PickImagesResult {
  canceled: boolean;
  files: PickedImageFile[];
  error?: string;
}

export const IPC_CHANNELS = {
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
