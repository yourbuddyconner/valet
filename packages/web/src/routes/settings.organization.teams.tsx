import { createFileRoute } from "@tanstack/react-router";
import { ApiError } from "~/api/client";
import {
  useJoinSuggestedTeam,
  useOrgDirectory,
  useSuggestedTeams,
} from "~/api/settings";
import { Button, Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { TeamsPanel } from "~/components/settings/teams-panel";
import { errorText } from "~/lib/error-text";

/**
 * Organization members manage their current teams and explicitly join teams
 * suggested from their latest identity-provider group claim. The server owns
 * eligibility and checks it again when Join runs.
 */
export const Route = createFileRoute("/settings/organization/teams")({
  validateSearch: (search: Record<string, unknown>) => ({ teamId: typeof search.teamId === "string" ? search.teamId : undefined }),
  component: OrganizationTeamsPage,
});

export function OrganizationTeamsPage() {
  const directoryQ = useOrgDirectory();
  const { teamId } = Route.useSearch();

  return (
    <Section title="Teams" description="Group members for scoped thread access.">
      <SuggestedTeams />
      {directoryQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {directoryQ.error != null &&
        (directoryQ.error instanceof ApiError && directoryQ.error.status === 404 ? (
          <p className="py-4 text-sm text-muted">Organizations aren't enabled</p>
        ) : (
          <p className="py-4 text-sm text-danger-500">
            Failed to load the member directory. Reload the page to try again.
          </p>
        ))}
      {directoryQ.data && <TeamsPanel orgMembers={directoryQ.data.users} teamId={teamId} />}
    </Section>
  );
}

function SuggestedTeams() {
  const suggestionsQ = useSuggestedTeams();
  const join = useJoinSuggestedTeam();

  if (suggestionsQ.isLoading) {
    return (
      <div className="flex items-center gap-2 border-b border-line py-4 text-sm text-muted">
        <Spinner size={14} /> Loading team suggestions…
      </div>
    );
  }
  if (suggestionsQ.error) {
    return (
      <p className="border-b border-line py-4 text-sm text-danger-500">
        Failed to load team suggestions. Reload the page to try again.
      </p>
    );
  }
  if (!suggestionsQ.data || suggestionsQ.data.teams.length === 0) return null;

  return (
    <div className="border-b border-line py-4">
      <h3 className="text-sm font-medium text-ink">Suggested teams</h3>
      <p className="mt-0.5 text-xs text-muted">
        Your identity provider indicates that you can join these teams.
      </p>
      <div className="mt-3 divide-y divide-line border-t border-line">
        {suggestionsQ.data.teams.map((team) => (
          <div key={team.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{team.name}</p>
              <p className="text-xs text-muted">
                {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={join.isPending}
              onClick={() => join.mutate(team.id)}
            >
              {join.isPending && join.variables === team.id ? "Joining…" : "Join"}
            </Button>
          </div>
        ))}
      </div>
      {join.error && (
        <p className="mt-2 text-xs text-danger-500">
          Could not join the team. {errorText(join.error)}
        </p>
      )}
    </div>
  );
}
