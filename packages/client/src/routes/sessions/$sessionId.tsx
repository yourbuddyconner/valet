import { createContext, useCallback, useContext, useState } from 'react';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { EditorDrawer } from '@/components/session/editor-drawer';
import { FilesDrawer } from '@/components/session/files-drawer';
import { ReviewDrawer } from '@/components/session/review-drawer';
import { LogsPanel } from '@/components/panels/logs-panel';
import { SessionMetadataSidebar } from '@/components/session/session-metadata-sidebar';
import { OrchestratorMetadataSidebar } from '@/components/session/orchestrator-metadata-sidebar';
import { SessionMetadataModal } from '@/components/session/session-metadata-modal';
import { useSession } from '@/api/sessions';
import type { LogEntry, ConnectedUser } from '@/hooks/use-chat';
import { useIsMobile } from '@/hooks/use-is-mobile';

type DrawerPanel = 'vscode' | 'desktop' | 'terminal' | 'files' | 'review' | 'logs' | null;

const DRAWER_STORAGE_KEY = 'valet:drawer-panel';
const LAYOUT_STORAGE_KEY = 'valet:editor-layout';
const SIDEBAR_STORAGE_KEY = 'valet:metadata-sidebar';

function loadDrawerState(): DrawerPanel {
  try {
    const val = localStorage.getItem(DRAWER_STORAGE_KEY);
    if (val === 'vscode' || val === 'desktop' || val === 'terminal' || val === 'files' || val === 'review' || val === 'logs') return val;
  } catch {
    // ignore
  }
  return null;
}

function saveDrawerState(panel: DrawerPanel) {
  try {
    if (panel) {
      localStorage.setItem(DRAWER_STORAGE_KEY, panel);
    } else {
      localStorage.removeItem(DRAWER_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

function loadSavedLayout(): Record<string, number> | undefined {
  try {
    const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function saveLayout(layout: Record<string, number>) {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // ignore
  }
}

export type SessionOverlay =
  | { type: 'transition'; message: string }
  | null;

export interface DrawerContextValue {
  activePanel: DrawerPanel;
  openVscode: () => void;
  openDesktop: () => void;
  openTerminal: () => void;
  openFiles: () => void;
  openReview: () => void;
  openLogs: () => void;
  closeDrawer: () => void;
  toggleVscode: () => void;
  toggleDesktop: () => void;
  toggleTerminal: () => void;
  toggleFiles: () => void;
  toggleReview: () => void;
  toggleLogs: () => void;
  logEntries: LogEntry[];
  setLogEntries: (entries: LogEntry[]) => void;
  overlay: SessionOverlay;
  setOverlay: (overlay: SessionOverlay) => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  connectedUsers: ConnectedUser[];
  setConnectedUsers: (users: ConnectedUser[]) => void;
  selectedModel: string | undefined;
  setSelectedModel: (model: string | undefined) => void;
  openFile: (path: string) => void;
  pendingFilePath: string | null;
  clearPendingFile: () => void;
}

const DrawerCtx = createContext<DrawerContextValue>({
  activePanel: null,
  openVscode: () => {},
  openDesktop: () => {},
  openTerminal: () => {},
  openFiles: () => {},
  openReview: () => {},
  openLogs: () => {},
  closeDrawer: () => {},
  toggleVscode: () => {},
  toggleDesktop: () => {},
  toggleTerminal: () => {},
  toggleFiles: () => {},
  toggleReview: () => {},
  toggleLogs: () => {},
  logEntries: [],
  setLogEntries: () => {},
  overlay: null,
  setOverlay: () => {},
  sidebarOpen: true,
  toggleSidebar: () => {},
  connectedUsers: [],
  setConnectedUsers: () => {},
  selectedModel: undefined,
  setSelectedModel: () => {},
  openFile: () => {},
  pendingFilePath: null,
  clearPendingFile: () => {},
});

export function useDrawer() {
  return useContext(DrawerCtx);
}

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionLayout,
});

function SessionLayout() {
  const { sessionId } = Route.useParams();
  const { data: session } = useSession(sessionId);
  const isMobile = useIsMobile();
  const [activePanel, setActivePanel] = useState<DrawerPanel>(loadDrawerState);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [overlay, setOverlay] = useState<SessionOverlay>(null);
  const [connectedUsers, setConnectedUsers] = useState<ConnectedUser[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const [mobileMetadataOpen, setMobileMetadataOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const val = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      return val !== 'false'; // default open
    } catch { return true; }
  });

  const openVscode = useCallback(() => {
    setActivePanel('vscode');
    saveDrawerState('vscode');
  }, []);

  const openDesktop = useCallback(() => {
    setActivePanel('desktop');
    saveDrawerState('desktop');
  }, []);

  const openTerminal = useCallback(() => {
    setActivePanel('terminal');
    saveDrawerState('terminal');
  }, []);

  const openFiles = useCallback(() => {
    setActivePanel('files');
    saveDrawerState('files');
  }, []);

  const openReview = useCallback(() => {
    setActivePanel('review');
    saveDrawerState('review');
  }, []);

  const openLogs = useCallback(() => {
    setActivePanel('logs');
    saveDrawerState('logs');
  }, []);

  const closeDrawer = useCallback(() => {
    setActivePanel(null);
    saveDrawerState(null);
  }, []);

  const toggleVscode = useCallback(() => {
    setActivePanel((prev) => {
      const next = prev === 'vscode' ? null : 'vscode';
      saveDrawerState(next);
      return next;
    });
  }, []);

  const toggleDesktop = useCallback(() => {
    setActivePanel((prev) => {
      const next = prev === 'desktop' ? null : 'desktop';
      saveDrawerState(next);
      return next;
    });
  }, []);

  const toggleTerminal = useCallback(() => {
    setActivePanel((prev) => {
      const next = prev === 'terminal' ? null : 'terminal';
      saveDrawerState(next);
      return next;
    });
  }, []);

  const toggleFiles = useCallback(() => {
    setActivePanel((prev) => {
      const next = prev === 'files' ? null : 'files';
      saveDrawerState(next);
      return next;
    });
  }, []);

  const toggleReview = useCallback(() => {
    setActivePanel((prev) => {
      const next = prev === 'review' ? null : 'review';
      saveDrawerState(next);
      return next;
    });
  }, []);

  const toggleLogs = useCallback(() => {
    setActivePanel((prev) => {
      const next = prev === 'logs' ? null : 'logs';
      saveDrawerState(next);
      return next;
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    if (isMobile) {
      setMobileMetadataOpen((prev) => !prev);
      return;
    }
    setSidebarOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, [isMobile]);

  const openFile = useCallback((path: string) => {
    setPendingFilePath(path);
    setActivePanel('files');
    saveDrawerState('files');
  }, []);

  const clearPendingFile = useCallback(() => {
    setPendingFilePath(null);
  }, []);


  const ctx: DrawerContextValue = {
    activePanel,
    openVscode,
    openDesktop,
    openTerminal,
    openFiles,
    openReview,
    openLogs,
    closeDrawer,
    toggleVscode,
    toggleDesktop,
    toggleTerminal,
    toggleFiles,
    toggleReview,
    toggleLogs,
    logEntries,
    setLogEntries,
    overlay,
    setOverlay,
    sidebarOpen: isMobile ? false : sidebarOpen,
    toggleSidebar,
    connectedUsers,
    setConnectedUsers,
    selectedModel,
    setSelectedModel,
    openFile,
    pendingFilePath,
    clearPendingFile,
  };

  const defaultLayout = loadSavedLayout();
  const isOpen = !isMobile && activePanel !== null;

  return (
    <DrawerCtx.Provider value={ctx}>
      <div className="relative h-full">
        {isOpen ? (
          <PanelGroup
            orientation="horizontal"
            defaultLayout={defaultLayout}
            onLayoutChanged={saveLayout}
            className="h-full"
          >
            <Panel defaultSize={25} minSize={20} className="!overflow-hidden">
              <Outlet />
            </Panel>
            <PanelResizeHandle className="group relative w-px bg-neutral-200 transition-colors hover:bg-accent/40 active:bg-accent dark:bg-neutral-800 dark:hover:bg-accent/40">
              <div className="absolute inset-y-0 -left-1 -right-1" />
            </PanelResizeHandle>
            <Panel defaultSize={75} minSize={30}>
              <div className="flex h-full">
                {sidebarOpen && (
                  session?.isOrchestrator
                    ? <OrchestratorMetadataSidebar sessionId={sessionId} connectedUsers={connectedUsers} selectedModel={selectedModel} compact />
                    : <SessionMetadataSidebar sessionId={sessionId} connectedUsers={connectedUsers} selectedModel={selectedModel} compact />
                )}
                <div className="flex-1 min-w-0">
                  {(activePanel === 'vscode' || activePanel === 'desktop' || activePanel === 'terminal') && (
                    <EditorDrawer sessionId={sessionId} activeTab={activePanel} />
                  )}
                  {activePanel === 'files' && (
                    <FilesDrawer sessionId={sessionId} />
                  )}
                  {activePanel === 'review' && (
                    <ReviewDrawer sessionId={sessionId} />
                  )}
                  {activePanel === 'logs' && (
                    <LogsDrawerWrapper logEntries={logEntries} onClose={closeDrawer} />
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        ) : (
          <>
            <div className="flex h-full">
              <div className="flex-1 min-w-0">
                <Outlet />
              </div>
              {!isMobile && sidebarOpen && (
                session?.isOrchestrator
                  ? <OrchestratorMetadataSidebar sessionId={sessionId} connectedUsers={connectedUsers} selectedModel={selectedModel} />
                  : <SessionMetadataSidebar sessionId={sessionId} connectedUsers={connectedUsers} selectedModel={selectedModel} />
              )}
            </div>

            {isMobile && (activePanel === 'vscode' || activePanel === 'desktop' || activePanel === 'terminal') && (
              <div className="absolute inset-0 z-40 bg-surface-0">
                <EditorDrawer sessionId={sessionId} activeTab={activePanel} />
              </div>
            )}
            {isMobile && activePanel === 'files' && (
              <div className="absolute inset-0 z-40 bg-surface-0">
                <FilesDrawer sessionId={sessionId} />
              </div>
            )}
            {isMobile && activePanel === 'review' && (
              <div className="absolute inset-0 z-40 bg-surface-0">
                <ReviewDrawer sessionId={sessionId} />
              </div>
            )}
            {isMobile && activePanel === 'logs' && (
              <div className="absolute inset-0 z-40 bg-surface-0">
                <LogsDrawerWrapper logEntries={logEntries} onClose={closeDrawer} />
              </div>
            )}

            {isMobile && (
              <SessionMetadataModal
                sessionId={sessionId}
                connectedUsers={connectedUsers}
                selectedModel={selectedModel}
                isOrchestrator={Boolean(session?.isOrchestrator)}
                open={mobileMetadataOpen}
                onOpenChange={setMobileMetadataOpen}
              />
            )}
          </>
        )}

        {/* Full-viewport overlay for hibernate transitions */}
        {overlay?.type === 'transition' && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-0/70 dark:bg-surface-0/80 backdrop-blur-[2px]">
            <div className="flex items-center gap-2.5 rounded-lg border border-neutral-200 bg-surface-0 px-4 py-2.5 shadow-sm dark:border-neutral-700 dark:bg-surface-1">
              <LoaderIcon className="h-4 w-4 animate-spin text-neutral-500" />
              <span className="font-mono text-[12px] text-neutral-600 dark:text-neutral-400">
                {overlay.message}
              </span>
            </div>
          </div>
        )}
      </div>
    </DrawerCtx.Provider>
  );
}

function LogsDrawerWrapper({ logEntries, onClose }: { logEntries: LogEntry[]; onClose: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 bg-surface-1 px-2 dark:border-neutral-800 dark:bg-surface-1">
        <span className="px-2.5 font-mono text-[11px] font-medium text-neutral-900 dark:text-neutral-100">
          Logs
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          Close
        </button>
      </div>
      <LogsPanel entries={logEntries} className="flex-1" />
    </div>
  );
}

function LoaderIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
