import { useState } from 'react';
import { useDrawer } from '@/hooks/use-drawer';
import { useChat } from '@/hooks/use-chat';
import { cn } from '@/lib/cn';
import { useReview } from './review/use-review';
import { ReviewControls } from './review/review-controls';
import { ReviewProgress } from './review/review-progress';
import { ReviewFileList } from './review/review-file-list';
import { ReviewDiffViewer } from './review/review-diff-viewer';
import { ReviewFindingsPanel } from './review/review-findings-panel';
import type { ReviewFinding } from './review/types';

type ReviewTab = 'diff' | 'findings';

interface ReviewDrawerProps {
  sessionId: string;
}

export function ReviewDrawer({ sessionId }: ReviewDrawerProps) {
  const { closeDrawer } = useDrawer();
  const {
    sendMessage,
    requestReview,
    reviewResult,
    reviewError,
    reviewLoading,
    reviewDiffFiles,
    isConnected,
  } = useChat(sessionId);

  const {
    state,
    review,
    error,
    selectedFile,
    diffFiles,
    startReview,
    applyFinding,
    clearReview,
    selectFile,
  } = useReview({
    sendMessage,
    requestReview,
    reviewResult,
    reviewError,
    reviewLoading,
    reviewDiffFiles,
    isConnected,
  });

  const [activeTab, setActiveTab] = useState<ReviewTab>('diff');

  const selectedDiffFile = diffFiles?.find((f) => f.path === selectedFile);
  const selectedFileFindings =
    review?.files.find((f) => f.path === selectedFile)?.findings || [];

  const handleNavigateToFinding = (finding: ReviewFinding) => {
    selectFile(finding.file);
    setActiveTab('diff');
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-neutral-50 dark:bg-neutral-900">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 bg-surface-1 px-2 dark:border-neutral-800 dark:bg-surface-1">
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 font-mono text-[11px] font-medium text-neutral-900 dark:text-neutral-100">
            Review
          </span>
          {state === 'complete' && review && (
            <ReviewStatsBadge stats={review.stats} />
          )}
        </div>
        <button
          type="button"
          onClick={closeDrawer}
          className="flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <PanelCloseIcon className="h-3.5 w-3.5" />
          Close Review
        </button>
      </div>

      {/* Controls */}
      <ReviewControls
        state={state}
        onStartReview={startReview}
        onClearReview={clearReview}
        isConnected={isConnected}
      />

      {/* Content area */}
      {state === 'idle' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          <ReviewIcon className="h-8 w-8 text-neutral-300 dark:text-neutral-600" />
          <p className="text-center font-mono text-[12px] text-neutral-500 dark:text-neutral-400">
            Run a review to analyze session changes
          </p>
          <p className="text-center font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
            The agent will analyze diffs and produce findings with severity levels
          </p>
        </div>
      )}

      {state === 'reviewing' && (
        <ReviewProgress state={state} />
      )}

      {state === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          <p className="font-mono text-[12px] text-red-500 dark:text-red-400">
            {error || 'Review failed'}
          </p>
        </div>
      )}

      {state === 'complete' && review && (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* File list sidebar — capped top strip on mobile, side column on md+ */}
          <div className="max-h-40 w-full shrink-0 overflow-y-auto border-b border-neutral-200 md:max-h-none md:w-56 md:overflow-visible md:border-b-0 md:border-r dark:border-neutral-800">
            <ReviewFileList
              files={review.files}
              selectedFile={selectedFile}
              onSelectFile={(path) => {
                selectFile(path);
                setActiveTab('diff');
              }}
            />
          </div>

          {/* Main area */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Tab bar */}
            <div className="flex items-center gap-0.5 border-b border-neutral-200 bg-surface-1 px-2 py-1 dark:border-neutral-800 dark:bg-surface-1">
              <TabButton active={activeTab === 'diff'} onClick={() => setActiveTab('diff')}>
                Diff
              </TabButton>
              <TabButton active={activeTab === 'findings'} onClick={() => setActiveTab('findings')}>
                Findings
                {review.files.flatMap((f) => f.findings).length > 0 && (
                  <span className="ml-1 text-neutral-400">
                    ({review.files.flatMap((f) => f.findings).length})
                  </span>
                )}
              </TabButton>
            </div>

            {/* Tab content */}
            {activeTab === 'diff' && (
              <ReviewDiffViewer
                diffFile={selectedDiffFile}
                findings={selectedFileFindings}
                onApplyFinding={applyFinding}
              />
            )}
            {activeTab === 'findings' && (
              <ReviewFindingsPanel
                review={review}
                selectedFile={selectedFile}
                onApplyFinding={applyFinding}
                onNavigateToFinding={handleNavigateToFinding}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewStatsBadge({ stats }: { stats: { critical: number; warning: number; suggestion: number; nitpick: number } }) {
  const total = stats.critical + stats.warning + stats.suggestion + stats.nitpick;
  if (total === 0) {
    return (
      <span className="rounded bg-green-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-green-700 dark:bg-green-900/40 dark:text-green-400">
        Clean
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {stats.critical > 0 && (
        <span className="rounded bg-red-100 px-1 py-0.5 font-mono text-[10px] font-bold text-red-700 dark:bg-red-900/40 dark:text-red-400">
          {stats.critical}C
        </span>
      )}
      {stats.warning > 0 && (
        <span className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[10px] font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
          {stats.warning}W
        </span>
      )}
      {stats.suggestion > 0 && (
        <span className="rounded bg-blue-100 px-1 py-0.5 font-mono text-[10px] font-bold text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
          {stats.suggestion}S
        </span>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11px] font-medium transition-colors',
        active
          ? 'bg-surface-0 text-neutral-900 shadow-sm dark:bg-surface-2 dark:text-neutral-100'
          : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300'
      )}
    >
      {children}
    </button>
  );
}

function PanelCloseIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
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
