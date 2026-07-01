import * as React from 'react';

interface OriginBreakdown {
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  callCount: number;
  percentage: number;
}

interface WorkflowRow {
  workflowId: string | null;
  workflowName: string;
  triggerType: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  callCount: number;
}

interface OriginBreakdownTableProps {
  data: OriginBreakdown[];
  /** Per-workflow drill-down for the automated (workflow) origin — which automation + how it fired. */
  byWorkflow?: WorkflowRow[];
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

function formatTrigger(triggerType: string): string {
  switch (triggerType) {
    case 'schedule':
      return 'scheduled';
    case 'webhook':
      return 'webhook';
    case 'manual':
      return 'manual';
    default:
      return triggerType;
  }
}

export function OriginBreakdownTable({ data, byWorkflow = [] }: OriginBreakdownTableProps) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const hasWorkflowData = byWorkflow.length > 0;

  const toggle = (purpose: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(purpose)) next.delete(purpose);
      else next.add(purpose);
      return next;
    });
  };

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
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h3 className="label-mono text-neutral-400">By Origin</h3>
        {hasWorkflowData && (
          <span className="font-mono text-2xs text-neutral-300 dark:text-neutral-600">tap Automated for workflows</span>
        )}
      </div>
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
              const canExpand = row.purpose === 'workflow' && hasWorkflowData;
              const isExpanded = expanded.has(row.purpose);
              return (
                <React.Fragment key={row.purpose}>
                  <tr
                    className={`border-b border-neutral-50 last:border-0 dark:border-neutral-800/50 ${canExpand ? 'cursor-pointer hover:bg-neutral-50/70 dark:hover:bg-neutral-800/30' : ''}`}
                    onClick={canExpand ? () => toggle(row.purpose) : undefined}
                    {...(canExpand ? { role: 'button', tabIndex: 0, 'aria-expanded': isExpanded } : {})}
                    onKeyDown={
                      canExpand
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggle(row.purpose);
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
                        <div className="flex flex-col">
                          <span className="font-medium text-neutral-900 dark:text-neutral-100">{name}</span>
                          {hint && <span className="font-mono text-2xs text-neutral-400">{hint}</span>}
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
                  {isExpanded && canExpand && (
                    <tr className="bg-neutral-50/60 dark:bg-neutral-800/20">
                      <td colSpan={6} className="px-2 py-2 sm:px-4">
                        <div className="overflow-x-auto rounded-md border border-neutral-100 dark:border-neutral-800">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-neutral-100 dark:border-neutral-800">
                                <th className="px-2 py-1.5 text-left font-mono text-2xs font-medium text-neutral-400">Automation</th>
                                <th className="px-2 py-1.5 text-left font-mono text-2xs font-medium text-neutral-400">Trigger</th>
                                <th className="px-2 py-1.5 text-right font-mono text-2xs font-medium text-neutral-400">Input</th>
                                <th className="px-2 py-1.5 text-right font-mono text-2xs font-medium text-neutral-400">Output</th>
                                <th className="px-2 py-1.5 text-right font-mono text-2xs font-medium text-neutral-400">Calls</th>
                                <th className="px-2 py-1.5 text-right font-mono text-2xs font-medium text-neutral-400">Cost</th>
                              </tr>
                            </thead>
                            <tbody>
                              {byWorkflow.map((wf) => (
                                <tr key={`${wf.workflowId ?? 'null'}:${wf.triggerType}`} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                                  <td className="max-w-[180px] truncate px-2 py-1.5">
                                    <span className="text-2xs text-neutral-700 dark:text-neutral-300">{wf.workflowName}</span>
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                                      {formatTrigger(wf.triggerType)}
                                    </span>
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-2xs tabular-nums text-neutral-500 dark:text-neutral-400">
                                    {formatTokens(wf.inputTokens)}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-2xs tabular-nums text-neutral-500 dark:text-neutral-400">
                                    {formatTokens(wf.outputTokens)}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-2xs tabular-nums text-neutral-500 dark:text-neutral-400">
                                    {wf.callCount.toLocaleString()}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-2xs tabular-nums text-neutral-600 dark:text-neutral-300">
                                    {formatCost(wf.cost)}
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
