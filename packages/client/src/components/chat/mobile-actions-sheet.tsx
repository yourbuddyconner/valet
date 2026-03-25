import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

interface MobileActionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVscode: () => void;
  onDesktop: () => void;
  onTerminal: () => void;
  onFiles: () => void;
  onReview: () => void;
  onLogs: () => void;
  onInfo: () => void;
  onShare?: () => void;
  prUrl?: string;
}

export function MobileActionsSheet({
  open,
  onOpenChange,
  onVscode,
  onDesktop,
  onTerminal,
  onFiles,
  onReview,
  onLogs,
  onInfo,
  onShare,
  prUrl,
}: MobileActionsSheetProps) {
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-[61] rounded-t-2xl border-t border-neutral-200 bg-surface-0 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-2xl dark:border-neutral-800 dark:bg-surface-1">
          <Dialog.Title className="mb-2 px-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
            Actions
          </Dialog.Title>
          <div className="grid grid-cols-2 gap-2">
            <MobileActionButton icon={<EditorIcon className="h-4 w-4" />} label="VS Code" onClick={() => run(onVscode)} />
            <MobileActionButton icon={<DesktopIcon className="h-4 w-4" />} label="Desktop" onClick={() => run(onDesktop)} />
            <MobileActionButton icon={<TerminalIcon className="h-4 w-4" />} label="Terminal" onClick={() => run(onTerminal)} />
            <MobileActionButton icon={<FilesIcon className="h-4 w-4" />} label="Files" onClick={() => run(onFiles)} />
            <MobileActionButton icon={<ReviewIcon className="h-4 w-4" />} label="Review" onClick={() => run(onReview)} />
            <MobileActionButton icon={<LogsIcon className="h-4 w-4" />} label="Logs" onClick={() => run(onLogs)} />
            <MobileActionButton icon={<InfoIcon className="h-4 w-4" />} label="Session Info" onClick={() => run(onInfo)} />
            {onShare && (
              <MobileActionButton icon={<ShareIcon className="h-4 w-4" />} label="Share" onClick={() => run(onShare)} />
            )}
            {prUrl && (
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="col-span-2 flex h-11 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-surface-1 px-3 text-[13px] font-medium text-neutral-700 dark:border-neutral-700 dark:bg-surface-2 dark:text-neutral-300"
                onClick={() => onOpenChange(false)}
              >
                <PRIcon className="h-4 w-4" />
                Open PR
              </a>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MobileActionButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-11 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-surface-1 px-3 text-[13px] font-medium text-neutral-700 active:scale-[0.98] dark:border-neutral-700 dark:bg-surface-2 dark:text-neutral-300"
    >
      {icon}
      {label}
    </button>
  );
}

function EditorIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function FilesIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function ReviewIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function PRIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" x2="6" y1="9" y2="21" />
    </svg>
  );
}

function LogsIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M13 12h8" />
      <path d="M13 18h8" />
      <path d="M13 6h8" />
      <path d="M3 12h1" />
      <path d="M3 18h1" />
      <path d="M3 6h1" />
      <path d="M8 12h1" />
      <path d="M8 18h1" />
      <path d="M8 6h1" />
    </svg>
  );
}

function DesktopIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" x2="12" y1="2" y2="15" />
    </svg>
  );
}
