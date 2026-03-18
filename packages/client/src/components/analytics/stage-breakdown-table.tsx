interface StageData {
  eventType: string;
  count: number;
  p50: number | null;
  p95: number | null;
}

interface StageBreakdownTableProps {
  data: StageData[];
}

const STAGE_LABELS: Record<string, string> = {
  queue_wait: 'Queue Wait',
  llm_response: 'LLM Response',
  sandbox_wake: 'Sandbox Wake',
  sandbox_restore: 'Sandbox Restore',
  tool_exec: 'Tool Exec',
  runner_connect: 'Runner Connect',
};

function formatStageName(eventType: string): string {
  return STAGE_LABELS[eventType] || eventType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'N/A';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function StageBreakdownTable({ data }: StageBreakdownTableProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        <h3 className="label-mono text-neutral-400 mb-4">Stage Breakdown</h3>
        <p className="text-sm text-neutral-300">No stage data</p>
      </div>
    );
  }

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none" style={{ animationDelay: '300ms' }}>
      <h3 className="label-mono text-neutral-400 mb-4">Stage Breakdown</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 dark:border-neutral-800">
              <th className="pb-2 pr-4 text-left font-mono text-2xs font-medium text-neutral-400">Stage</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Count</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">P50</th>
              <th className="pb-2 pl-4 text-right font-mono text-2xs font-medium text-neutral-400">P95</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.eventType} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                <td className="py-2.5 pr-4 font-medium text-neutral-900 dark:text-neutral-100">
                  {formatStageName(row.eventType)}
                </td>
                <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                  {row.count.toLocaleString()}
                </td>
                <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                  {formatDuration(row.p50)}
                </td>
                <td className="py-2.5 pl-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                  {formatDuration(row.p95)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
