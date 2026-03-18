import { HeroMetricCard } from '@/components/dashboard/hero-metric-card';

interface PerfHeroMetricsProps {
  hero: {
    turnLatencyP50: number | null;
    turnLatencyP95: number | null;
    queueWaitP50: number | null;
    sandboxWakeP50: number | null;
    errorRate: number;
    turnCount: number;
    errorCount: number;
  };
}

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

function QueueIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function SandboxIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M15 2v2" />
      <path d="M15 20v2" />
      <path d="M2 15h2" />
      <path d="M2 9h2" />
      <path d="M20 15h2" />
      <path d="M20 9h2" />
      <path d="M9 2v2" />
      <path d="M9 20v2" />
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

export function PerfHeroMetrics({ hero }: PerfHeroMetricsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <HeroMetricCard
        icon={<ClockIcon />}
        label="Turn Latency"
        value={formatDuration(hero.turnLatencyP50)}
        tooltip={`P50: ${formatDuration(hero.turnLatencyP50)} | P95: ${formatDuration(hero.turnLatencyP95)}`}
        index={0}
      />
      <HeroMetricCard
        icon={<QueueIcon />}
        label="Queue Wait"
        value={formatDuration(hero.queueWaitP50)}
        tooltip="P50 queue wait time"
        index={1}
      />
      <HeroMetricCard
        icon={<SandboxIcon />}
        label="Sandbox Wake"
        value={formatDuration(hero.sandboxWakeP50)}
        tooltip="P50 sandbox wake time"
        index={2}
      />
      <HeroMetricCard
        icon={<AlertIcon />}
        label="Error Rate"
        value={`${hero.errorRate.toFixed(1)}%`}
        tooltip={`${hero.errorCount} errors / ${hero.turnCount} turns`}
        index={3}
      />
    </div>
  );
}
