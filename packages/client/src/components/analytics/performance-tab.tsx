import { useAnalyticsPerformance } from '@/api/analytics';
import { PerfHeroMetrics } from './perf-hero-metrics';
import { LatencyTrendChart } from './latency-trend-chart';
import { StageBreakdownTable } from './stage-breakdown-table';
import { SlowPathsTable } from './slow-paths-table';

export function PerformanceTab({ period }: { period: number }) {
  const { data, isLoading } = useAnalyticsPerformance(period);

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
          ))}
        </div>
        <div className="h-[320px] rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
      </div>
    );
  }

  if (!data) {
    return <div className="flex h-64 items-center justify-center text-sm text-neutral-400">No performance data available</div>;
  }

  return (
    <div className="space-y-6">
      <PerfHeroMetrics hero={data.hero} />
      <LatencyTrendChart data={data.trend} />
      <div className="grid gap-6 lg:grid-cols-2">
        <StageBreakdownTable data={data.stages} />
        <SlowPathsTable data={data.slowPaths} />
      </div>
    </div>
  );
}
