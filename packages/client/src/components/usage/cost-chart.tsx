import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface CostByDay {
  date: string;
  cost: number | null;
  inputTokens: number;
  outputTokens: number;
}

interface CostChartProps {
  data: CostByDay[];
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatCost(val: number): string {
  if (val < 0.01) return `$${val.toFixed(4)}`;
  if (val < 1) return `$${val.toFixed(3)}`;
  return `$${val.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; dataKey: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const costEntry = payload.find(p => p.dataKey === 'cost');
  const tokensEntry = payload.find(p => p.dataKey === 'tokens');
  return (
    <div className="rounded-lg border border-neutral-200/80 bg-white px-3 py-2.5 shadow-[0_4px_12px_-4px_rgb(0_0_0/0.1)] dark:border-neutral-700 dark:bg-surface-2">
      <p className="mb-1.5 font-mono text-2xs text-neutral-400">{formatDateLabel(String(label))}</p>
      {costEntry && (
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: costEntry.color }} />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">Cost</span>
          <span className="ml-auto font-mono text-xs font-medium tabular-nums text-neutral-900 dark:text-neutral-100">
            {costEntry.value != null ? formatCost(costEntry.value) : 'N/A'}
          </span>
        </div>
      )}
      {tokensEntry && (
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokensEntry.color }} />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">Tokens</span>
          <span className="ml-auto font-mono text-xs font-medium tabular-nums text-neutral-900 dark:text-neutral-100">
            {formatTokens(tokensEntry.value)}
          </span>
        </div>
      )}
    </div>
  );
}

export function CostChart({ data }: CostChartProps) {
  const chartData = data.map(d => ({
    date: d.date,
    cost: d.cost,
    tokens: d.inputTokens + d.outputTokens,
  }));

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        <h3 className="label-mono text-neutral-400 mb-4">Daily Cost</h3>
        <div className="flex h-[240px] items-center justify-center text-[13px] text-neutral-300">
          No usage data for this period
        </div>
      </div>
    );
  }

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none" style={{ animationDelay: '200ms' }}>
      <h3 className="label-mono text-neutral-400 mb-4">Daily Cost & Token Usage</h3>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(168 85 247)" stopOpacity={0.12} />
              <stop offset="100%" stopColor="rgb(168 85 247)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(59 130 246)" stopOpacity={0.12} />
              <stop offset="100%" stopColor="rgb(59 130 246)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(245 245 245)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateLabel}
            tick={{ fontSize: 10, fill: '#a3a3a3', fontFamily: '"JetBrains Mono", monospace' }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="cost"
            orientation="left"
            tick={{ fontSize: 10, fill: '#a3a3a3', fontFamily: '"JetBrains Mono", monospace' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => v > 0 ? `$${v < 1 ? v.toFixed(2) : v.toFixed(0)}` : '$0'}
            width={50}
          />
          <YAxis
            yAxisId="tokens"
            orientation="right"
            tick={{ fontSize: 10, fill: '#a3a3a3', fontFamily: '"JetBrains Mono", monospace' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => formatTokens(v)}
            width={50}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            yAxisId="cost"
            type="monotone"
            dataKey="cost"
            name="Cost"
            stroke="rgb(168 85 247)"
            strokeWidth={1.5}
            fill="url(#gradCost)"
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 2, fill: 'white', stroke: 'rgb(168 85 247)' }}
            connectNulls
          />
          <Area
            yAxisId="tokens"
            type="monotone"
            dataKey="tokens"
            name="Tokens"
            stroke="rgb(59 130 246)"
            strokeWidth={1.5}
            fill="url(#gradTokens)"
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 2, fill: 'white', stroke: 'rgb(59 130 246)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex items-center justify-end gap-4 pt-2">
        <div className="flex items-center gap-1.5">
          <span className="h-[3px] w-3 rounded-full" style={{ backgroundColor: 'rgb(168 85 247)' }} />
          <span className="font-mono text-2xs text-neutral-400">Cost</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-[3px] w-3 rounded-full" style={{ backgroundColor: 'rgb(59 130 246)' }} />
          <span className="font-mono text-2xs text-neutral-400">Tokens</span>
        </div>
      </div>
    </div>
  );
}
