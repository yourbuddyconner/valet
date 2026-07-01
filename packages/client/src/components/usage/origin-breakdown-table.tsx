interface OriginBreakdown {
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  callCount: number;
  percentage: number;
}

interface OriginBreakdownTableProps {
  data: OriginBreakdown[];
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

/** Friendly label + one-line hint for a session `purpose`. */
function formatOrigin(purpose: string): { name: string; hint: string } {
  switch (purpose) {
    case 'interactive':
      return { name: 'Interactive', hint: 'user sessions' };
    case 'workflow':
      return { name: 'Automated', hint: 'workflows · scheduled triggers' };
    case 'orchestrator':
      return { name: 'Orchestrator', hint: 'assistant' };
    default:
      return { name: purpose.charAt(0).toUpperCase() + purpose.slice(1), hint: '' };
  }
}

export function OriginBreakdownTable({ data }: OriginBreakdownTableProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        <h3 className="label-mono text-neutral-400 mb-4">By Origin</h3>
        <p className="text-sm text-neutral-300">No usage data</p>
      </div>
    );
  }

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none" style={{ animationDelay: '250ms' }}>
      <h3 className="label-mono text-neutral-400 mb-4">By Origin</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 dark:border-neutral-800">
              <th className="pb-2 pr-4 text-left font-mono text-2xs font-medium text-neutral-400">Origin</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Input</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Output</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Calls</th>
              <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Cost</th>
              <th className="pb-2 pl-4 text-right font-mono text-2xs font-medium text-neutral-400">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const { name, hint } = formatOrigin(row.purpose);
              return (
                <tr key={row.purpose} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                  <td className="py-2.5 pr-4">
                    <div className="flex flex-col">
                      <span className="font-medium text-neutral-900 dark:text-neutral-100">{name}</span>
                      {hint && (
                        <span className="font-mono text-2xs text-neutral-400">{hint}</span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                    {formatTokens(row.inputTokens)}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                    {formatTokens(row.outputTokens)}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                    {row.callCount.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
                    {formatCost(row.cost)}
                  </td>
                  <td className="py-2.5 pl-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                        <div
                          className="h-full rounded-full bg-blue-500/60"
                          style={{ width: `${Math.min(row.percentage, 100)}%` }}
                        />
                      </div>
                      <span className="w-10 font-mono text-2xs tabular-nums text-neutral-400">
                        {row.percentage}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
