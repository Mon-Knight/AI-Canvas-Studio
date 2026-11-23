import { useEffect, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Board } from "./canvas/Board";
import { LeftFloatingDock } from "./canvas/LeftFloatingDock";
import { TopLeftProjectBar } from "./components/TopLeftProjectBar";
import { TopRightCapsuleBar } from "./components/TopRightCapsuleBar";
import { ChatDock } from "./components/ChatDock";
import { ReferencesPanel } from "./components/ReferencesPanel";
import { Toaster } from "./components/Toaster";
import { GenerationDialog } from "./components/GenerationDialog";
import { ResultViewer } from "./components/ResultViewer";
import { EmbeddedFlowModal } from "./components/EmbeddedFlowModal";
import { DirectorStageModal } from "./components/DirectorStageModal";
import { LayerEditorModal } from "./components/LayerEditorModal";
import { ShutdownOverlay } from "./components/ShutdownOverlay";
import { useBoardStore } from "./store/board";
import { useDesktopFlowStore } from "./store/desktopFlow";
import { useReferencesStore } from "./store/references";
import { useShutdownStore } from "./store/shutdown";

export function App() {
  const loadInitialBoard = useBoardStore((s) => s.loadInitialBoard);
  const loadReferences = useReferencesStore((s) => s.load);
  const initDesktopFlow = useDesktopFlowStore((s) => s.init);
  const loading = useBoardStore((s) => s.loading);
  const boardId = useBoardStore((s) => s.boardId);
  const shutdownPhase = useShutdownStore((s) => s.phase);
  const ran = useRef(false);

  useEffect(() => {
    const cleanupDesktop = initDesktopFlow();
    return cleanupDesktop;
  }, [initDesktopFlow]);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void loadInitialBoard();
    void loadReferences();
  }, [loadInitialBoard, loadReferences]);

  return (
    <ReactFlowProvider>
      <div className={`app${shutdownPhase !== "idle" ? " app--shutting-down" : ""}`}>
        <div className="canvas-wrap">
          {/* 中心极光氛围微光背景层（点亮无限画布点阵） */}
          <div className="jm-canvas-aurora" aria-hidden="true" />

          {loading && boardId === null ? (
            <div className="canvas-loading">正在加载画布…</div>
          ) : (
            <Board />
          )}

          {/* 五区悬浮毛玻璃岛屿 */}
          <TopLeftProjectBar />
          <TopRightCapsuleBar />
          <LeftFloatingDock />
          <ChatDock />
          <ReferencesPanel />
        </div>

        <Toaster />
        <GenerationDialog />
        <ResultViewer />
        <EmbeddedFlowModal />
        <DirectorStageModal />
        <LayerEditorModal />
        <ShutdownOverlay />
      </div>
    </ReactFlowProvider>
  );
}
