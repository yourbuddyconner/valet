import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { useDashboardStats } from '@/api/dashboard';
import { useOrchestratorInfo } from '@/api/orchestrator';
import { useAutoRestartOrchestrator } from '@/hooks/use-auto-restart-orchestrator';
import { PeriodSelector } from '@/components/dashboard/period-selector';
import { LiveSessionsBanner } from '@/components/dashboard/live-sessions-banner';
import { HeroMetrics } from '@/components/dashboard/hero-metrics';
import { ActivityChart } from '@/components/dashboard/activity-chart';
import { ActivityFeed } from '@/components/dashboard/activity-feed';
import { TopRepositories } from '@/components/dashboard/top-repositories';
import { AdoptionCard } from '@/components/dashboard/adoption-card';
import { DashboardSkeleton } from '@/components/dashboard/dashboard-skeleton';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage() {
  const [period, setPeriod] = useState(720);
  const { data, isLoading, isError } = useDashboardStats(period);

  return (
    <PageContainer>
      <PageHeader
        title="Dashboard"
        description="Overview of your team's AI agent activity"
        actions={<PeriodSelector value={period} onChange={setPeriod} />}
      />

      {isError && (
        <div className="mb-6 rounded-lg bg-red-50 p-4 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-400">
          Failed to load dashboard data
        </div>
      )}

      <OrchestratorBanner />

      {isLoading || !data ? (
        <DashboardSkeleton />
      ) : (
        <div className="space-y-6">
          <LiveSessionsBanner sessions={data.activeSessions} />
          <HeroMetrics hero={data.hero} userHero={data.userHero} delta={data.delta} />
          <ActivityChart data={data.activity} />
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <ActivityFeed sessions={data.recentSessions} />
            </div>
            <div className="lg:col-span-2 space-y-6">
              <TopRepositories repos={data.topRepos} />
              <AdoptionCard />
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function OrchestratorBanner() {
  const { data, isLoading } = useOrchestratorInfo();
  const autoRestart = useAutoRestartOrchestrator();

  if (isLoading) return null;

  // No identity at all — show setup CTA
  if (!data?.identity) {
    return (
      <div className="mb-6 flex items-center justify-between rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-800/50">
        <div>
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Set up your personal orchestrator
          </p>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            A persistent AI assistant that manages tasks and coordinates your agent sessions
          </p>
        </div>
        <Link
          to="/orchestrator"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90"
        >
          Get Started
        </Link>
      </div>
    );
  }

  // Identity exists but session is dead — auto-restart in progress
  if (data.needsRestart) {
    return (
      <div className="mb-6 flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 text-sm font-semibold text-amber-600 dark:bg-amber-900/50 dark:text-amber-400">
            {data.identity.name.charAt(0)}
          </div>
          <div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {data.identity.name} is offline
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              @{data.identity.handle} &middot; {autoRestart.isRestarting ? 'Restarting...' : autoRestart.restartFailed ? 'Restart failed' : 'Session ended'}
            </p>
          </div>
        </div>
        {autoRestart.restartFailed ? (
          <button
            onClick={autoRestart.retry}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Retry
          </button>
        ) : (
          <span className="text-sm text-amber-600 dark:text-amber-400">
            {autoRestart.isRestarting ? 'Restarting...' : 'Restarting...'}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mb-6 flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
          {data.identity.name.charAt(0)}
        </div>
        <div>
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {data.identity.name}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            @{data.identity.handle}
            {data.session && (
              <span className="ml-2">
                {data.session.status === 'running' || data.session.status === 'idle'
                  ? 'Online'
                  : data.session.status === 'hibernated'
                    ? 'Sleeping'
                    : data.session.status}
              </span>
            )}
          </p>
        </div>
      </div>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: 'orchestrator' }}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Talk to {data.identity.name}
      </Link>
    </div>
  );
}
