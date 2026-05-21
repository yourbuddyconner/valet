import { createContext, useContext } from 'react';
import type { LogEntry, ConnectedUser } from '@/hooks/use-chat';

export type DrawerPanel = 'vscode' | 'desktop' | 'terminal' | 'files' | 'review' | 'logs' | null;

export type SessionOverlay =
  | { type: 'transition'; message: string }
  | null;

export type { ConnectedUser } from '@/hooks/use-chat';

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

export const DrawerCtx = createContext<DrawerContextValue>({
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
