import { buildInfo, getBuildChrome } from '@/lib/build-info';
import { cn } from '@/lib/cn';

type BuildBadgeProps = {
  className?: string;
  compact?: boolean;
};

export function BuildBadge({ className, compact = false }: BuildBadgeProps) {
  const chrome = getBuildChrome();
  const title = [
    `Environment: ${buildInfo.label}`,
    buildInfo.versionTag ? `Version: ${buildInfo.versionTag}` : undefined,
    `Commit: ${buildInfo.commitHash}`,
  ].filter(Boolean).join(' | ');

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-md border border-neutral-200/70 bg-white/55 px-1.5 py-1 font-mono text-[9px] leading-none text-neutral-600 shadow-sm dark:border-neutral-700/60 dark:bg-black/20 dark:text-neutral-300 sm:gap-1.5 sm:px-2 sm:text-[10px]',
        compact ? 'max-w-[34vw] sm:max-w-none' : 'max-w-[48vw] sm:max-w-none',
        className
      )}
      title={title}
      aria-label={title}
    >
      <span className={cn('shrink-0 rounded border px-1 py-0.5 text-[9px] font-semibold uppercase sm:px-1.5 sm:text-[10px]', chrome.badgeClassName)}>
        {buildInfo.label}
      </span>
      {buildInfo.versionTag && (
        <span className="min-w-0 max-w-[4.75rem] truncate text-neutral-700 dark:text-neutral-200 sm:max-w-24">
          {buildInfo.versionTag}
        </span>
      )}
      <span className="shrink-0 text-neutral-500 dark:text-neutral-400">
        {buildInfo.shortCommitHash}
      </span>
    </div>
  );
}
