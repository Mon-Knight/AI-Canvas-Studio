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

export interface FlowboardDesktopAPI {
  getState(): Promise<FlowEngineState>;
  onStateChange(listener: (state: FlowEngineState) => void): () => void;
  openDrawer(opts?: OpenFlowDrawerOptions): Promise<FlowEngineState>;
  closeDrawer(): Promise<FlowEngineState>;
  setDrawerBounds(bounds: FlowViewBounds): Promise<void>;
  reloadFlow(): Promise<void>;
  openStandaloneAuthWindow(): Promise<void>;
  syncAccountsNow(): Promise<FlowEngineState>;
  pairWithCode(code: string): Promise<PairResult>;
  pickImages(opts?: PickImagesOptions): Promise<PickImagesResult>;
  quitApp(): Promise<void>;
}

declare global {
  interface Window {
    flowboardDesktop?: FlowboardDesktopAPI;
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.flowboardDesktop);
}
