import * as React from 'react';
import { groupModelsByUser, formatModelLabel, type UserModelRow } from './user-breakdown';

interface UserBreakdown {
  userId: string;
  email: string;
  name?: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  sessionCount: number;
  sandboxCost: number;
  sandboxActiveSeconds: number;
}

interface UserBreakdownTableProps {
  data: UserBreakdown[];
  /** Per-user per-model rows used for the drill-down. */
  byUserModel?: UserModelRow[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatCost(cost: number | null): string {
  if (cost === null) return 'N/A';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return '-';
  const hours = seconds / 3600;
  if (hours < 0.1) return `${Math.round(seconds / 60)}m`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

export function UserBreakdownTable({ data, byUserModel = [] }: UserBreakdownTableProps) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  // Group the per-model rows by user so each expanded row can render its own
  // model breakdown without re-filtering on every render.
  const modelsByUser = React.useMemo(() => groupModelsByUser(byUserModel), [byUserModel]);
  const hasModelData = byUserModel.length > 0;

  const toggle = (userId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        <h3 className="label-mono text-neutral-400 mb-4">By User</h3>
        <p className="text-sm text-neutral-300">No user usage data</p>
      </div>
    );
  }

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none" style={{ animationDelay: '350ms' }}>
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h3 className="label-mono text-neutral-400">By User</h3>
        {hasModelData && (
          <span className="font-mono text-2xs text-neutral-300 dark:text-neutral-600">tap a row for models</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 dark:border-neutral-800">
              <th className="pb-2 pr-4 text-left font-mono text-2xs font-medium text-neutral-400">User</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Input</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Output</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Compute</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Sessions</th>
              <th className="pb-2 pl-4 text-right font-mono text-2xs font-medium text-neutral-400">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const models = modelsByUser.get(row.userId) ?? [];
              const isExpanded = expanded.has(row.userId);
              const canExpand = models.length > 0;
              return (
                <React.Fragment key={row.userId}>
                  <tr
                    className={`border-b border-neutral-50 last:border-0 dark:border-neutral-800/50 ${canExpand ? 'cursor-pointer hover:bg-neutral-50/70 dark:hover:bg-neutral-800/30' : ''}`}
                    onClick={canExpand ? () => toggle(row.userId) : undefined}
                    {...(canExpand ? { role: 'button', tabIndex: 0, 'aria-expanded': isExpanded } : {})}
                    onKeyDown={
                      canExpand
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggle(row.userId);
                            }
                          }
                        : undefined
                    }
                  >
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center gap-2">
                        <ChevronIcon
                          className={`h-3.5 w-3.5 shrink-0 text-neutral-300 transition-transform dark:text-neutral-600 ${isExpanded ? 'rotate-90' : ''} ${canExpand ? '' : 'invisible'}`}
                        />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate font-medium text-neutral-900 dark:text-neutral-100">
                            {row.name || row.email.split('@')[0]}
                          </span>
                          <span className="truncate font-mono text-2xs text-neutral-400">{row.email}</span>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                      {formatTokens(row.inputTokens)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                      {formatTokens(row.outputTokens)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                      {formatDuration(row.sandboxActiveSeconds)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                      {row.sessionCount}
                    </td>
                    <td className="py-2.5 pl-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                      {formatCost(row.cost)}
                    </td>
                  </tr>
                  {isExpanded && canExpand && (
                    <tr className="bg-neutral-50/60 dark:bg-neutral-800/20">
                      <td colSpan={6} className="px-2 py-2 sm:px-4">
                        <div className="overflow-x-auto rounded-md border border-neutral-100 dark:border-neutral-800">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-neutral-100 dark:border-neutral-800">
                                <th className="px-2 py-1.5 text-left font-mono text-2xs font-medium text-neutral-400">Model</th>
                                <th className="px-2 py-1.5 text-right font-mono text-2xs font-medium text-neutral-400">Input</th>
                                <th className="px-2 py-1.5 text-right font-mono text-2xs font-medium text-neutral-400">Output</th>
                                <th className="px-2 py-1.5 text-right font-mono text-2xs font-medium text-neutral-400">Calls</th>
                                <th className="px-2 py-1.5 text-right font-mono text-2xs font-medium text-neutral-400">Cost</th>
                              </tr>
                            </thead>
                            <tbody>
                              {models.map((m) => (
                                <tr key={m.model} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                                  <td className="max-w-[160px] truncate px-2 py-1.5">
                                    <span className="font-mono text-2xs text-neutral-700 dark:text-neutral-300">
                                      {formatModelLabel(m.model)}
                                    </span>
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-2xs tabular-nums text-neutral-500 dark:text-neutral-400">
                                    {formatTokens(m.inputTokens)}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-2xs tabular-nums text-neutral-500 dark:text-neutral-400">
                                    {formatTokens(m.outputTokens)}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-2xs tabular-nums text-neutral-500 dark:text-neutral-400">
                                    {m.callCount.toLocaleString()}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-2xs tabular-nums text-neutral-600 dark:text-neutral-300">
                                    {formatCost(m.cost)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
