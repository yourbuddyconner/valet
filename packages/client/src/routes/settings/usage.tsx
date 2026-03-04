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

export const Route = createFileRoute('/settings/usage')({
  component: UsagePage,
});

function UsagePage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [period, setPeriod] = React.useState(720); // default 30 days in hours

  // Redirect non-admins
  React.useEffect(() => {
    if (user && user.role !== 'admin') {
      navigate({ to: '/settings', search: { tab: 'general' } });
    }
  }, [user, navigate]);

  const { data, isLoading } = useUsageStats(period);

  if (!user || user.role !== 'admin') {
    return null;
  }

  return (
    <PageContainer>
      <div className="flex items-center justify-between">
        <PageHeader
          title="Usage & Cost"
          description="LLM token usage and cost breakdown across your organization"
        />
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {isLoading ? (
        <UsageSkeleton />
      ) : data ? (
        <div className="space-y-6">
          <UsageHeroMetrics
            totalCost={data.hero.totalCost}
            totalInputTokens={data.hero.totalInputTokens}
            totalOutputTokens={data.hero.totalOutputTokens}
            totalSessions={data.hero.totalSessions}
            totalUsers={data.hero.totalUsers}
          />
          <CostChart data={data.costByDay} />
          <div className="grid gap-6 lg:grid-cols-2">
            <ModelBreakdownTable data={data.byModel} />
            <UserBreakdownTable data={data.byUser} />
          </div>
        </div>
      ) : (
        <div className="flex h-64 items-center justify-center text-sm text-neutral-400">
          No usage data available
        </div>
      )}
    </PageContainer>
  );
}

function UsageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
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
