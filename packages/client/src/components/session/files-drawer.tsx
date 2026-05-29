import { useDrawer } from '@/hooks/use-drawer';
import { useSession } from '@/api/sessions';
import { FileBrowser } from '@/components/files/file-browser';
import { useIsMobile } from '@/hooks/use-is-mobile';

interface FilesDrawerProps {
  sessionId: string;
}

export function FilesDrawer({ sessionId }: FilesDrawerProps) {
  const isMobile = useIsMobile();
  const { closeDrawer, pendingFilePath, clearPendingFile } = useDrawer();
  const { data: session } = useSession(sessionId);
  const initialFilePath = pendingFilePath;
  const isHibernated = session?.status === 'hibernated';

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-neutral-50 dark:bg-neutral-900">
      {/* Header */}
      <div className={`shrink-0 border-b border-neutral-200 bg-surface-1 dark:border-neutral-800 dark:bg-surface-1 ${isMobile ? 'flex h-12 items-center justify-between px-3' : 'flex h-10 items-center justify-between px-2'}`}>
        <span className="px-2.5 font-mono text-[11px] font-medium text-neutral-900 dark:text-neutral-100">
          Files
        </span>
        <button
          type="button"
          onClick={closeDrawer}
          className={`flex items-center gap-1.5 rounded font-mono font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 ${isMobile ? 'px-2.5 py-1.5 text-[12px]' : 'px-2.5 py-1 text-[11px]'}`}
        >
          <PanelCloseIcon className="h-3.5 w-3.5" />
          Close Files
        </button>
      </div>
      {!isMobile && <div className="flex h-8 shrink-0 items-center border-b border-neutral-100 dark:border-neutral-800/50" />}

      {/* File browser or hibernate message */}
      {isHibernated ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
            Session is hibernated — send a message to wake
          </p>
        </div>
      ) : (
        <div className={`min-h-0 min-w-0 flex-1 overflow-hidden ${isMobile ? 'p-2.5' : 'p-4'}`}>
          <FileBrowser sessionId={sessionId} initialFilePath={initialFilePath} onFileConsumed={clearPendingFile} />
        </div>
      )}
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
