import { useWorkspaceRuntimeInfo } from "~/api/workspace-runtime";
import { createFileRoute } from "@tanstack/react-router";
import { MemoryCard } from "~/components/assistant/memory-card";
import { TeamsCard } from "~/components/assistant/teams-card";
import { WorkspaceCatchUp } from "~/components/dashboard/workspace-catch-up";
import { UsageCard } from "~/components/assistant/usage-card";
import { TeamDashboard } from "~/components/dashboard/team-dashboard";
import { Spinner } from "~/components/primitives";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/** Home follows the workspace switcher and shows the personal or team activity dashboard. */
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
  const info = useWorkspaceRuntimeInfo("user");

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

  return <DashboardBody />;
}

function DashboardBody() {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
        <header><h1 className="font-display text-2xl">Personal</h1><p className="mt-1 text-sm text-muted">Your briefing: what needs attention, what finished, and what comes next.</p></header>
        <WorkspaceCatchUp />
        <div className="grid gap-4 md:grid-cols-2">
          <MemoryCard />
          <UsageCard />
          <TeamsCard />
        </div>
      </div>
    </div>
  );
}
