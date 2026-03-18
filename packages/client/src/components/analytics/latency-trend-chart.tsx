import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface TrendPoint {
  date: string;
  p50: number | null;
  p95: number | null;
  count: number;
}

interface LatencyTrendChartProps {
  data: TrendPoint[];
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'N/A';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number | null; color: string; dataKey: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const p50Entry = payload.find(p => p.dataKey === 'p50');
  const p95Entry = payload.find(p => p.dataKey === 'p95');
  const countEntry = payload.find(p => p.dataKey === 'count');
  return (
    <div className="rounded-lg border border-neutral-200/80 bg-white px-3 py-2.5 shadow-[0_4px_12px_-4px_rgb(0_0_0/0.1)] dark:border-neutral-700 dark:bg-surface-2">
      <p className="mb-1.5 font-mono text-2xs text-neutral-400">{formatDateLabel(String(label))}</p>
      {p50Entry && (
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: p50Entry.color }} />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">P50</span>
          <span className="ml-auto font-mono text-xs font-medium tabular-nums text-neutral-900 dark:text-neutral-100">
            {formatDuration(p50Entry.value)}
          </span>
        </div>
      )}
      {p95Entry && (
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: p95Entry.color }} />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">P95</span>
          <span className="ml-auto font-mono text-xs font-medium tabular-nums text-neutral-900 dark:text-neutral-100">
            {formatDuration(p95Entry.value)}
          </span>
        </div>
      )}
      {countEntry && (
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-300" />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">Events</span>
          <span className="ml-auto font-mono text-xs font-medium tabular-nums text-neutral-900 dark:text-neutral-100">
            {countEntry.value}
          </span>
        </div>
      )}
    </div>
  );
}

export function LatencyTrendChart({ data }: LatencyTrendChartProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        <h3 className="label-mono text-neutral-400 mb-4">Turn Latency Trend</h3>
        <div className="flex h-[240px] items-center justify-center text-[13px] text-neutral-300">
          No latency data for this period
        </div>
      </div>
    );
  }

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none" style={{ animationDelay: '200ms' }}>
      <h3 className="label-mono text-neutral-400 mb-4">Turn Latency Trend</h3>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="gradP50" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.12} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradP95" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#93c5fd" stopOpacity={0.12} />
              <stop offset="100%" stopColor="#93c5fd" stopOpacity={0} />
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
            tick={{ fontSize: 10, fill: '#a3a3a3', fontFamily: '"JetBrains Mono", monospace' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`}
            width={50}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="p95"
            name="P95"
            stroke="#93c5fd"
            strokeWidth={1.5}
            fill="url(#gradP95)"
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 2, fill: 'white', stroke: '#93c5fd' }}
            connectNulls
          />
          <Area
            type="monotone"
            dataKey="p50"
            name="P50"
            stroke="#3b82f6"
            strokeWidth={1.5}
            fill="url(#gradP50)"
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 2, fill: 'white', stroke: '#3b82f6' }}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex items-center justify-end gap-4 pt-2">
        <div className="flex items-center gap-1.5">
          <span className="h-[3px] w-3 rounded-full" style={{ backgroundColor: '#3b82f6' }} />
          <span className="font-mono text-2xs text-neutral-400">P50</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-[3px] w-3 rounded-full" style={{ backgroundColor: '#93c5fd' }} />
          <span className="font-mono text-2xs text-neutral-400">P95</span>
        </div>
      </div>
    </div>
  );
}
