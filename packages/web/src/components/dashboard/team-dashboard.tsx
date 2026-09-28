import { Link } from "@tanstack/react-router";
import { useMemoryTree } from "~/api/memory";
import { useTeams } from "~/api/settings";
import { useUsageBreakdown } from "~/api/usage";
import { memoryStats } from "~/components/assistant/memory-card";
import { TeamSlackSetupCard } from "~/components/events/team-slack-setup";
import { Badge, ErrorRow, LoadingRow } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { formatTokens, formatUsd } from "~/lib/format-usage";
import { WorkspaceCatchUp } from "./workspace-catch-up";

export function TeamDashboard({ teamId }: { teamId: string }) {
  const teams = useTeams();
  const team = teams.error ? undefined : teams.data?.teams.find(row => row.id === teamId);
  return <div className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
    <header className="space-y-1"><div className="flex flex-wrap items-center gap-3"><h1 className="font-display text-2xl">{team?.name ?? "Team"}</h1>{team && <Badge variant="neutral">{team.memberCount} members</Badge>}</div><p className="text-sm text-muted">Catch up on your team’s work.</p></header>
    <WorkspaceCatchUp owner={{ ownerType: "team", ownerId: teamId }} />
    <TeamSlackSetupCard key={teamId} teamId={teamId} />
    <div className="grid gap-4 md:grid-cols-2"><TeamUsageCard teamId={teamId} /><TeamMemoryCard teamId={teamId} /></div>
  </div></div>;
}

function CardShell({
  title,
  link,
  children,
}: {
  title: string;
  link?: { to: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-lg border border-line bg-paper">
      <header className="flex flex-wrap items-center justify-between gap-x-3 border-b border-line px-4 py-3">
        <h2 className="font-display text-base text-ink">{title}</h2>
        {link && (
          <Link to={link.to} className="inline-flex min-h-11 items-center text-xs text-moss underline-offset-2 sm:min-h-0 hover:underline">
            {link.label}
          </Link>
        )}
      </header>
      <div className="space-y-3 px-4 py-3">{children}</div>
    </section>
  );
}

function TeamUsageCard({ teamId }: { teamId: string }) {
  const usageQ = useUsageBreakdown({ kind: "lookback", window: "7d" }, "team", teamId);
  const data = usageQ.data;
  return (
    <CardShell title="Usage" link={{ to: "/usage", label: "View all usage →" }}>
      {usageQ.error != null ? (
        <ErrorRow>Could not load team usage: {errorText(usageQ.error)}</ErrorRow>
      ) : data === undefined ? (
        <LoadingRow />
      ) : (
        <div className="space-y-1">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-xl text-ink">{formatUsd(data.totalCostUsd)}</span>
            <span className="text-xs text-muted">this week</span>
          </div>
          <p className="text-xs text-muted">
            {formatTokens(data.totalTokens)} tokens · {data.totalTurns} turns
          </p>
        </div>
      )}
    </CardShell>
  );
}

function TeamMemoryCard({ teamId }: { teamId: string }) {
  const treeQ = useMemoryTree({ ownerType: "team", ownerId: teamId });
  const stats = treeQ.data === undefined ? undefined : memoryStats(treeQ.data.entries);
  return (
    <CardShell title="Memory" link={{ to: "/memory", label: "Open memory →" }}>
      {treeQ.error != null ? (
        <ErrorRow>Could not load team memory: {errorText(treeQ.error)}</ErrorRow>
      ) : stats === undefined ? (
        <LoadingRow />
      ) : stats.files === 0 ? (
        <p className="text-sm text-muted">
          No team memory yet. The team’s assistant writes here as it works.
        </p>
      ) : (
        <div className="flex flex-wrap gap-6 text-sm text-ink">
          <div>
            <div className="font-display text-xl">{stats.notes}</div>
            <div className="text-xs text-muted">notes</div>
          </div>
          <div>
            <div className="font-display text-xl">{stats.journalDays}</div>
            <div className="text-xs text-muted">journal days</div>
          </div>
          <div>
            <div className="font-display text-xl">{stats.pinned}</div>
            <div className="text-xs text-muted">pinned</div>
          </div>
        </div>
      )}
    </CardShell>
  );
}
