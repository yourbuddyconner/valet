import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useOrgDirectory } from "~/api/settings";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { TeamsPanel } from "~/components/settings/teams-panel";
import { useWorkspaceScope } from "~/lib/workspace-scope";

export const Route = createFileRoute("/settings/team")({
  component: TeamSettingsPage,
});

export function TeamSettingsPage() {
  const { teamId } = useWorkspaceScope();
  if (teamId === undefined) return <Navigate to="/settings/profile" replace />;
  // Drop drafts and open confirmation dialogs before changing their target.
  return <SelectedTeamSettings key={teamId} teamId={teamId} />;
}

function SelectedTeamSettings({ teamId }: { teamId: string }) {
  const directory = useOrgDirectory();

  return (
    <Section title="Team" description="Settings for the selected team workspace.">
      <div className="py-3">
        <Link to="/chat" search={{ workspace: teamId }} className="text-sm text-moss underline-offset-2 hover:underline">
          Open threads
        </Link>
      </div>
      {directory.isLoading ? (
        <LoadingRow label="Loading team settings…" />
      ) : directory.error != null ? (
        <ErrorRow>Failed to load the member directory. Reload the page to try again.</ErrorRow>
      ) : directory.data ? (
        <TeamsPanel orgMembers={directory.data.users} teamId={teamId} showAssistantLink />
      ) : (
        <ErrorRow>Team settings are unavailable. Select another workspace or reload the page.</ErrorRow>
      )}
    </Section>
  );
}
