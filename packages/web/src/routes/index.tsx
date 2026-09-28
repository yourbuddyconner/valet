import { createFileRoute } from "@tanstack/react-router";
import type { GetOrchestratorInfoResponse } from "@valet/api/wire";
import { useOrchestratorChildren, useOrchestratorInfo } from "~/api/orchestrator";
import { useNotifications } from "~/api/queries";
import { ActivityStrip, mergeActivity } from "~/components/assistant/activity-strip";
import { MemoryCard } from "~/components/assistant/memory-card";
import { TeamsCard } from "~/components/assistant/teams-card";
import { ThreadsCard } from "~/components/assistant/threads-card";
import { UsageCard } from "~/components/assistant/usage-card";
import { TeamDashboard } from "~/components/dashboard/team-dashboard";
import { Spinner } from "~/components/primitives";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/` — the dashboard. Follows the workspace switcher, exactly like every
 * list page (team dashboard design, 2026-08-27): the personal workspace
 * renders the assistant dashboard (assistant-centered web UI, decision 1);
 * a team workspace renders the team's activity dashboard.
 *
 * The personal branch works as before: `GET /api/orchestrator/info` with
 * `name === null` means first visit — an inline, full-page-centered
 * identity step (decision 11); once named, the identity header + card grid
 * + activity strip.
 */
export const Route = createFileRoute("/")({
  component: Home,
});

export function Home() {
  const scope = useWorkspaceScope();
  if (scope.teamId !== undefined) {
    return <TeamDashboard teamId={scope.teamId} />;
  }
  return <Dashboard />;
}

export function Dashboard() {
  const info = useOrchestratorInfo();

  if (info.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (info.error || !info.data) {
    return (
      <div className="flex-1 grid place-items-center p-8 text-center text-sm text-danger-500">
        <div>
          Couldn’t load your workspace.
          <div className="mt-2">
            <button type="button" className="min-h-11 px-3 underline sm:min-h-0" onClick={() => info.refetch()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <DashboardBody info={info.data} />;
}

function DashboardBody({ info }: { info: GetOrchestratorInfoResponse }) {
  const childrenQ = useOrchestratorChildren();
  const notificationsQ = useNotifications();

  const events = mergeActivity(notificationsQ.data?.notifications ?? [], childrenQ.data?.children ?? []);

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
        <div className="space-y-2">
          <h1 className="font-display text-2xl">Personal</h1>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <ThreadsCard />
          </div>
          <MemoryCard />
          <UsageCard />
          <TeamsCard />
        </div>

        <ActivityStrip
          events={events}
          loading={notificationsQ.isLoading || childrenQ.isLoading}
          error={!!notificationsQ.error || !!childrenQ.error}
          onRetry={() => {
            notificationsQ.refetch();
            childrenQ.refetch();
          }}
        />
      </div>
    </div>
  );
}
