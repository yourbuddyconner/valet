import { Link } from "@tanstack/react-router";
import type { TeamSummary } from "@valet/api/wire";
import { Users } from "lucide-react";
import { useOrg, useTeams } from "~/api/settings";
import { Spinner } from "~/components/primitives";
import { eligibleTeams } from "~/components/session/assistant-rail";

/** Links to each team workspace the caller may open. */
function TeamRow({ team }: { team: TeamSummary }) {
  const body = (
    <>
      <Users className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 break-words text-sm text-ink sm:truncate">{team.name}</span>
      <span className="shrink-0 text-xs text-muted">
        {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
      </span>
    </>
  );

  return (
    <Link
      to="/chat"
      search={{ workspace: team.id }}
      className="flex min-h-11 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-ink-wash focus-visible:outline-none focus-visible:bg-ink-wash"
    >
      {body}
    </Link>
  );
}

export function TeamsCard() {
  const orgQ = useOrg();
  const teamsQ = useTeams();

  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const resolved = orgQ.data !== undefined && teamsQ.data !== undefined;

  if (teamsQ.isLoading || orgQ.isLoading) {
    return (
      <section className="min-w-0 rounded-lg border border-line bg-paper flex flex-col min-h-0">
        <header className="px-4 py-3 border-b border-line">
          <h2 className="font-display text-base text-ink">Your teams</h2>
        </header>
        <div className="px-4 py-3 flex items-center gap-2 text-xs text-muted">
          <Spinner size={14} /> Loading…
        </div>
      </section>
    );
  }

  // Not a member of anything: no card at all. An empty "Your teams" panel
  // would be scaffolding for a feature this user does not have.
  if (!resolved || teams.length === 0) return null;

  return (
    <section className="min-w-0 rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line">
        <h2 className="font-display text-base text-ink">Your teams</h2>
      </header>

      <ul className="flex-1 overflow-y-auto max-h-64 divide-y divide-line">
        {teams.map((team) => (
          <li key={team.id}>
            <TeamRow team={team} />
          </li>
        ))}
      </ul>
    </section>
  );
}
