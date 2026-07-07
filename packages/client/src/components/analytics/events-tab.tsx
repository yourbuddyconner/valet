import * as React from 'react';
import { useAnalyticsEvents } from '@/api/analytics';
import { Link } from '@tanstack/react-router';

const TYPE_FILTERS = [
  { label: 'All', value: undefined },
  { label: 'LLM', value: 'llm_' },
  { label: 'Turn', value: 'turn_' },
  { label: 'Queue', value: 'queue_' },
  { label: 'Sandbox', value: 'sandbox_' },
  { label: 'Session', value: 'session.' },
  { label: 'Agent', value: 'agent.' },
  { label: 'Workflow', value: 'workflow.' },
] as const;

const PAGE_SIZE = 50;

const CATEGORY_COLORS: Record<string, string> = {
  llm: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  turn: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  queue: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  sandbox: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  session: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  agent: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  user: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  workflow: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  runner: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  tool: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  prompt: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  channel: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  watchdog: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  git: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300',
  opencode: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300',
  tunnel: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300',
};

function getEventCategory(eventType: string): string {
  const dot = eventType.indexOf('.');
  const underscore = eventType.indexOf('_');
  if (dot > 0) return eventType.slice(0, dot);
  if (underscore > 0) return eventType.slice(0, underscore);
  return eventType;
}

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400';
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const then = new Date(normalized).getTime();
  if (Number.isNaN(then)) return dateStr;
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 0) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ${diffMin % 60}m ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function truncate(str: string | null, maxLen: number): string {
  if (!str) return '-';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\u2026';
}

function formatSessionLabel(sessionId: string, sessionTitle: string | null): string {
  if (sessionId.startsWith('orchestrator:org:')) return 'Org Orchestrator';
  if (sessionId.startsWith('orchestrator:')) return 'Orchestrator';
  if (sessionTitle) return truncate(sessionTitle, 24);
  return sessionId.slice(0, 8);
}

function formatUserName(userName: string | null, userEmail: string | null): string | null {
  if (userName) return userName;
  if (userEmail) return userEmail.split('@')[0];
  return null;
}

export function EventsTab({ period }: { period: number }) {
  const [typeFilter, setTypeFilter] = React.useState<string | undefined>(undefined);
  const [page, setPage] = React.useState(0);

  React.useEffect(() => {
    setPage(0);
  }, [typeFilter]);

  const offset = page * PAGE_SIZE;
  const { data, isLoading } = useAnalyticsEvents(period, typeFilter, PAGE_SIZE, offset);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="space-y-4">
      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setTypeFilter(f.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              typeFilter === f.value
                ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-neutral-200/80 bg-white shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        {isLoading ? (
          <div className="space-y-3 animate-pulse p-6">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 rounded bg-neutral-100 dark:bg-neutral-800" />
            ))}
          </div>
        ) : !data || data.events.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-neutral-400">
            No events found
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-700">
                  <th className="py-3 pl-6 pr-4 text-left font-mono text-2xs font-semibold uppercase tracking-wider text-neutral-400">Time</th>
                  <th className="py-3 px-4 text-left font-mono text-2xs font-semibold uppercase tracking-wider text-neutral-400">User</th>
                  <th className="py-3 px-4 text-left font-mono text-2xs font-semibold uppercase tracking-wider text-neutral-400">Event Type</th>
                  <th className="hidden md:table-cell py-3 px-4 text-right font-mono text-2xs font-semibold uppercase tracking-wider text-neutral-400">Duration</th>
                  <th className="py-3 px-4 text-left font-mono text-2xs font-semibold uppercase tracking-wider text-neutral-400">Details</th>
                  <th className="hidden md:table-cell py-3 pr-6 pl-4 text-left font-mono text-2xs font-semibold uppercase tracking-wider text-neutral-400">Session</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => {
                  const category = getEventCategory(event.eventType);
                  const userName = formatUserName(event.userName, event.userEmail);
                  const detail = event.summary || (event.properties ? JSON.stringify(event.properties) : null);

                  return (
                    <tr key={event.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/50 dark:border-neutral-800/50 dark:hover:bg-neutral-800/20">
                      <td className="py-3 pl-6 pr-4 whitespace-nowrap text-sm text-neutral-500 dark:text-neutral-400">
                        {formatRelativeTime(event.createdAt)}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        {userName ? (
                          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                            {userName}
                          </span>
                        ) : (
                          <span className="text-sm text-neutral-300 dark:text-neutral-600">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          <span className={`inline-flex rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none ${getCategoryColor(category)}`}>
                            {category}
                          </span>
                          <span className="font-mono text-xs text-neutral-700 dark:text-neutral-300">
                            {event.eventType}
                          </span>
                        </span>
                      </td>
                      <td className="hidden md:table-cell py-3 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                        {formatDuration(event.durationMs)}
                      </td>
                      <td className="py-3 px-4 max-w-[200px] md:max-w-[400px]">
                        {detail ? (
                          <span className="text-xs text-neutral-500 dark:text-neutral-400" title={detail}>
                            {truncate(detail, 80)}
                          </span>
                        ) : (
                          <span className="text-xs text-neutral-300 dark:text-neutral-600">-</span>
                        )}
                      </td>
                      <td className="hidden md:table-cell py-3 pr-6 pl-4 whitespace-nowrap">
                        <Link
                          to="/sessions/$sessionId"
                          params={{ sessionId: event.sessionId }}
                          className="text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                        >
                          {formatSessionLabel(event.sessionId, event.sessionTitle)}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {data && data.total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-neutral-200 px-6 py-3 dark:border-neutral-700">
            <span className="font-mono text-2xs text-neutral-400">
              {offset + 1}-{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages - 1}
                className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
