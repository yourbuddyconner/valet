import { useSession, useSessionToken } from '@/api/sessions';
import { useDrawer } from '@/hooks/use-drawer';
import { VSCodePanel, VNCPanel, TerminalPanel } from '@/components/panels';
import { cn } from '@/lib/cn';

export type EditorTab = 'vscode' | 'desktop' | 'terminal';

const tabLabels: Record<EditorTab, string> = {
  vscode: 'VS Code',
  desktop: 'Desktop',
  terminal: 'Terminal',
};

interface EditorDrawerProps {
  sessionId: string;
  activeTab: EditorTab;
}

export function EditorDrawer({ sessionId, activeTab }: EditorDrawerProps) {
  const { data: session, isLoading: sessionLoading } = useSession(sessionId);
  const { data: tokenData, isLoading: tokenLoading, isError: tokenError } = useSessionToken(sessionId);
  const { closeDrawer } = useDrawer();

  const gatewayUrl = tokenData?.tunnelUrls?.gateway || session?.gatewayUrl;
  const token = tokenData?.token;
  const panelsLoading = sessionLoading || tokenLoading;
  const isHibernated = session?.status === 'hibernated';
  const hibernateMessage = isHibernated ? 'Session is hibernated — send a message to wake' : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* Status banners */}
      {tokenError && session?.status === 'initializing' && (
        <div className="flex items-center gap-2 border-b border-blue-200 bg-blue-50 px-3 py-1.5 font-mono text-[11px] text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
          Sandbox starting up...
        </div>
      )}
      {tokenError && session && session.status !== 'initializing' && session.status !== 'terminated' && session.status !== 'archived' && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 font-mono text-[11px] text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
          Connection lost. Retrying...
        </div>
      )}

      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 bg-surface-1 px-2 dark:border-neutral-800 dark:bg-surface-1">
        <span className="px-2.5 font-mono text-[11px] font-medium text-neutral-900 dark:text-neutral-100">
          {tabLabels[activeTab]}
        </span>
        <button
          type="button"
          onClick={closeDrawer}
          className="flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <PanelCloseIcon className="h-3.5 w-3.5" />
          Close
        </button>
      </div>

      {/* Panel content */}
      <div className="relative flex-1">
        <div className={cn('absolute inset-0', activeTab !== 'vscode' && 'invisible')}>
          <VSCodePanel
            gatewayUrl={gatewayUrl}
            token={token}
            isLoading={panelsLoading}
            statusMessage={hibernateMessage}
            className="h-full w-full"
          />
        </div>
        <div className={cn('absolute inset-0', activeTab !== 'desktop' && 'invisible')}>
          <VNCPanel
            gatewayUrl={gatewayUrl}
            token={token}
            isLoading={panelsLoading}
            statusMessage={hibernateMessage}
            className="h-full w-full"
          />
        </div>
        <div className={cn('absolute inset-0', activeTab !== 'terminal' && 'invisible')}>
          <TerminalPanel
            gatewayUrl={gatewayUrl}
            token={token}
            isLoading={panelsLoading}
            statusMessage={hibernateMessage}
            className="h-full w-full"
          />
        </div>
      </div>
    </div>
  );
}

function PanelCloseIcon({ className }: { className?: string }) {
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
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </svg>
  );
}

