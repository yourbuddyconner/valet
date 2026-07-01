import type { DashboardTopRepo } from '@/api/types';

interface TopRepositoriesProps {
  repos: DashboardTopRepo[];
}

export function TopRepositories({ repos }: TopRepositoriesProps) {
  const maxSessions = Math.max(...repos.map((r) => r.sessionCount), 1);

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none" style={{ animationDelay: '340ms' }}>
      <div className="border-b border-neutral-100 dark:border-neutral-800 px-5 py-3.5">
        <h3 className="label-mono text-neutral-400">Top Repositories</h3>
      </div>
      {repos.length === 0 ? (
        <div className="px-5 py-10 text-center text-[13px] text-neutral-300">
          No repository data
        </div>
      ) : (
        <div className="divide-y divide-neutral-100/80 dark:divide-neutral-800">
          {repos.map((repo, i) => {
            const pct = (repo.sessionCount / maxSessions) * 100;
            return (
              <div key={repo.workspace} className="px-5 py-3">
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <span className="min-w-0 truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                    <span className="font-mono text-2xs text-neutral-300 mr-1.5 tabular-nums">{i + 1}</span>
                    {repo.workspace}
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-neutral-400 tabular-nums">
                    {repo.sessionCount}s &middot; {repo.messageCount}m
                  </span>
                </div>
                <div className="h-1 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent/70 transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
