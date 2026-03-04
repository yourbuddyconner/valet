import { HeroMetricCard } from '@/components/dashboard/hero-metric-card';

interface UsageHeroMetricsProps {
  totalCost: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
  totalUsers: number;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(cost: number | null): string {
  if (cost === null) return 'N/A';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function DollarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

function TokenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function SessionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function UsageHeroMetrics({ totalCost, totalInputTokens, totalOutputTokens, totalSessions, totalUsers }: UsageHeroMetricsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <HeroMetricCard
        icon={<DollarIcon />}
        label="Total Cost"
        value={formatCost(totalCost)}
        index={0}
      />
      <HeroMetricCard
        icon={<TokenIcon />}
        label="Total Tokens"
        value={formatTokenCount(totalInputTokens + totalOutputTokens)}
        tooltip={`Input: ${totalInputTokens.toLocaleString()} | Output: ${totalOutputTokens.toLocaleString()}`}
        index={1}
      />
      <HeroMetricCard
        icon={<SessionIcon />}
        label="Sessions"
        value={totalSessions.toLocaleString()}
        index={2}
      />
      <HeroMetricCard
        icon={<UsersIcon />}
        label="Active Users"
        value={totalUsers.toLocaleString()}
        index={3}
      />
    </div>
  );
}
