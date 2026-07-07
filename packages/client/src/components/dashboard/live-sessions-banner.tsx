import { Link } from '@tanstack/react-router';
import type { DashboardActiveSession } from '@/api/types';

interface LiveSessionsBannerProps {
  sessions: DashboardActiveSession[];
}

export function LiveSessionsBanner({ sessions }: LiveSessionsBannerProps) {
  if (sessions.length === 0) return null;

  return (
    <div className="animate-fade-in rounded-lg border border-emerald-200/60 bg-gradient-to-r from-emerald-50/80 via-emerald-50/50 to-transparent px-4 py-3 dark:border-emerald-800/40 dark:from-emerald-950/40 dark:via-emerald-950/20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="shrink-0 text-[13px] font-medium text-emerald-700 dark:text-emerald-400">
          {sessions.length} active {sessions.length === 1 ? 'session' : 'sessions'}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {sessions.slice(0, 3).map((s) => (
            <Link
              key={s.id}
              to="/sessions/$sessionId"
              params={{ sessionId: s.id }}
              className="max-w-[100px] truncate rounded-md border border-emerald-200/50 bg-white/60 px-2.5 py-1 font-mono text-2xs font-medium text-emerald-700 shadow-[0_1px_2px_0_rgb(0_0_0/0.03)] transition-all hover:bg-white hover:shadow-[0_1px_3px_0_rgb(0_0_0/0.06)] sm:max-w-[140px] dark:border-emerald-800/50 dark:bg-emerald-950/40 dark:text-emerald-400 dark:hover:bg-emerald-950/60 dark:shadow-none"
            >
              {s.workspace || 'Untitled'}
            </Link>
          ))}
          {sessions.length > 3 && (
            <span className="font-mono text-2xs text-emerald-500">
              +{sessions.length - 3}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
