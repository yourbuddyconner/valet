import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { PeriodSelector } from '@/components/dashboard/period-selector';
import { useAuthStore } from '@/stores/auth';
import { useUsageStats } from '@/api/usage';
import { UsageHeroMetrics } from '@/components/usage/hero-metrics';
import { CostChart } from '@/components/usage/cost-chart';
import { ModelBreakdownTable } from '@/components/usage/model-breakdown-table';
import { UserBreakdownTable } from '@/components/usage/user-breakdown-table';
import { PerformanceTab } from '@/components/analytics/performance-tab';
import { EventsTab } from '@/components/analytics/events-tab';

export const Route = createFileRoute('/settings/usage')({
  component: UsagePage,
});

function UsagePage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [period, setPeriod] = React.useState(720); // default 30 days in hours
  const [tab, setTab] = React.useState<'billing' | 'performance' | 'events'>('billing');

  // Redirect non-admins
  React.useEffect(() => {
    if (user && user.role !== 'admin') {
      navigate({ to: '/settings', search: { tab: 'general' } });
    }
  }, [user, navigate]);

  if (!user || user.role !== 'admin') {
    return null;
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <PageHeader
            title="Analytics"
            description="Usage, performance, and event analytics across your organization"
          />
          <PeriodSelector value={period} onChange={setPeriod} />
        </div>

        <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
          {(['billing', 'performance', 'events'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                tab === t
                  ? 'border-b-2 border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'billing' && <BillingContent period={period} />}
        {tab === 'performance' && <PerformanceTab period={period} />}
        {tab === 'events' && <EventsTab period={period} />}
      </div>
    </PageContainer>
  );
}

function BillingContent({ period }: { period: number }) {
  const { data, isLoading } = useUsageStats(period);

  if (isLoading) {
    return <UsageSkeleton />;
  }

  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-neutral-400">
        No usage data available
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <UsageHeroMetrics
        totalCost={data.hero.totalCost}
        totalInputTokens={data.hero.totalInputTokens}
        totalOutputTokens={data.hero.totalOutputTokens}
        totalSessions={data.hero.totalSessions}
        totalUsers={data.hero.totalUsers}
        sandboxCost={data.hero.sandboxCost}
        sandboxActiveSeconds={data.hero.sandboxActiveSeconds}
      />
      <CostChart data={data.costByDay} />
      <div className="grid gap-6 lg:grid-cols-2">
        <ModelBreakdownTable data={data.byModel} />
        <UserBreakdownTable data={data.byUser} />
      </div>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
      <div className="h-[320px] rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-64 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        <div className="h-64 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
      </div>
    </div>
  );
}
