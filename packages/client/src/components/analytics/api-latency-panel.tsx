import type { RequestMetricsResponse } from '@valet/shared';
import { HeroMetricCard } from '@/components/dashboard/hero-metric-card';

type Hero = RequestMetricsResponse['hero'];
type Route = RequestMetricsResponse['routes'][number];

function formatDuration(ms: number | null): string {
  if (ms === null) return 'N/A';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function HeroRow({ hero }: { hero: Hero }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <HeroMetricCard icon={<ClockIcon />} label="API P50" value={formatDuration(hero.p50)} tooltip="Median API request latency" index={0} />
      <HeroMetricCard icon={<ClockIcon />} label="API P95" value={formatDuration(hero.p95)} tooltip="95th percentile API request latency" index={1} />
      <HeroMetricCard icon={<ClockIcon />} label="API P99" value={formatDuration(hero.p99)} tooltip="99th percentile API request latency" index={2} />
      <HeroMetricCard icon={<HashIcon />} label="Requests" value={hero.count.toLocaleString()} tooltip="Requests recorded in the selected window" index={3} />
      <HeroMetricCard icon={<AlertIcon />} label="Error Rate" value={`${(hero.errorRate * 100).toFixed(1)}%`} tooltip="Share of requests returning a 5xx status" index={4} />
    </div>
  );
}

function SlowRoutesTable({ routes }: { routes: Route[] }) {
  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none" style={{ animationDelay: '350ms' }}>
      <h3 className="label-mono text-neutral-400 mb-4">Slowest API Routes</h3>
      {routes.length === 0 ? (
        <p className="text-sm text-neutral-300">No request data yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-100 dark:border-neutral-800">
                <th className="pb-2 pr-4 text-left font-mono text-2xs font-medium text-neutral-400">Method</th>
                <th className="pb-2 px-4 text-left font-mono text-2xs font-medium text-neutral-400">Route</th>
                <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">Count</th>
                <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">P50</th>
                <th className="pb-2 px-4 text-right font-mono text-2xs font-medium text-neutral-400">P95</th>
                <th className="pb-2 pl-4 text-right font-mono text-2xs font-medium text-neutral-400">Err</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((row, idx) => (
                <tr key={`${row.method}-${row.route}-${idx}`} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                  <td className="py-2.5 pr-4 font-mono text-xs font-medium text-neutral-600 dark:text-neutral-300">{row.method}</td>
                  <td className="py-2.5 px-4 font-mono text-xs text-neutral-900 dark:text-neutral-100">{row.route}</td>
                  <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">{row.count.toLocaleString()}</td>
                  <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">{formatDuration(row.p50)}</td>
                  <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">{formatDuration(row.p95)}</td>
                  <td className="py-2.5 pl-4 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-300">{`${(row.errorRate * 100).toFixed(0)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ApiLatencyPanel({ data }: { data: RequestMetricsResponse }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="label-mono text-neutral-400 mb-3">API Request Latency</h3>
        <HeroRow hero={data.hero} />
      </div>
      <SlowRoutesTable routes={data.routes} />
    </div>
  );
}
