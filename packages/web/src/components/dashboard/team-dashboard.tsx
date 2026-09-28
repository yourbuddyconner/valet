/**
 * The team workspace home (team dashboard design, 2026-08-27): what the
 * team's agents did, newest first, with workflows/usage/artifacts/memory
 * cards below. Renders when the workspace switcher names a team — the
 * personal dashboard is untouched (`routes/index.tsx` branches).
 *
 * Every card degrades independently: its own loading row, its own error row
 * with Retry. A failed card never blanks the page.
 */
import { Link } from "@tanstack/react-router";
import type {
  GlobalWorkflowRunSummary,
  TeamChildSummary,
} from "@valet/api/wire";
import { useArtifacts } from "~/api/artifacts";
import { useMemoryTree } from "~/api/memory";
import { useTeamChildren } from "~/api/orchestrator";
import { useTeams } from "~/api/settings";
import { useUsageBreakdown } from "~/api/usage";
import { useRuns, useWorkflows } from "~/api/workflows";
import { memoryStats } from "~/components/assistant/memory-card";
import { TeamSlackSetupCard } from "~/components/events/team-slack-setup";
import { Badge, Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { formatTokens, formatUsd } from "~/lib/format-usage";
import { relativeTime } from "~/lib/relative-time";

// ── feed (pure, exported for tests) ───────────────────────────────────────

export interface TeamFeedItem {
  kind: "child-run" | "workflow-run";
  key: string;
  /** Child session id, or run id — the link target. */
  targetId: string;
  title: string;
  /** Who did it: the spawning assistant, or the workflow. */
  actor: string;
  statusLabel: string;
  tone: "running" | "done" | "failed";
  createdAt: number;
}

/** Merge the team's assistant runs and workflow runs into one newest-first
 * feed, capped — a dashboard shows the latest activity, not history. */
export function mergeTeamFeed(
  children: readonly TeamChildSummary[],
  runs: readonly GlobalWorkflowRunSummary[],
  cap = 15,
): TeamFeedItem[] {
  const items: TeamFeedItem[] = [
    ...children.map(
      (c): TeamFeedItem => ({
        kind: "child-run",
        key: `child:${c.sessionId}`,
        targetId: c.sessionId,
        title: c.title,
        actor: "Team work",
        statusLabel: c.status,
        tone: c.status === "running" ? "running" : "done",
        createdAt: c.createdAt,
      }),
    ),
    ...runs.map(
      (r): TeamFeedItem => ({
        kind: "workflow-run",
        key: `run:${r.runId}`,
        targetId: r.runId,
        title: r.workflowName,
        actor: r.workflowName,
        statusLabel: r.outcome ?? r.status,
        tone:
          r.outcome === "failed" || r.outcome === "cancelled"
            ? "failed"
            : r.status === "settled"
              ? "done"
              : "running",
        createdAt: r.createdAt,
      }),
    ),
  ];
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, cap);
}

const TONE_CLASS: Record<TeamFeedItem["tone"], string> = {
  running: "text-amber",
  done: "text-muted",
  failed: "text-danger-500",
};

// ── page ───────────────────────────────────────────────────────────────────

export function TeamDashboard({ teamId }: { teamId: string }) {
  const teamsQ = useTeams();
  const childrenQ = useTeamChildren(teamId);
  const workflowsQ = useWorkflows({ ownerType: "team", ownerId: teamId });

  const team = teamsQ.data?.teams.find((t) => t.id === teamId);


  // Runs are reachable only through the team's workflow ids: the runs route
  // scopes to the CALLER, so an unfiltered list would mix in personal runs.
  // The client short-circuits an empty id list to { runs: [] }.
  const workflowIds = workflowsQ.data?.workflows.map((w) => w.id);
  // limit 200 = the server's page max: the feed only needs the 15 newest,
  // but the Workflows card counts runs in 24h from this same page, and the
  // 50-row default silently capped that count for busy teams.
  const runsQ = useRuns(
    { workflowIds: workflowIds ?? [], limit: 200 },
    { enabled: workflowIds !== undefined, refetchInterval: 30_000 },
  );

  const children = childrenQ.data?.children ?? [];
  const feed = mergeTeamFeed(children, runsQ.data?.runs ?? []);

  // The workflows query gates the runs query, so "still loading" includes
  // it — otherwise a team whose activity is all workflow runs flashes the
  // empty state before the runs arrive.
  const feedLoading =
    childrenQ.data === undefined ||
    workflowsQ.data === undefined ||
    (workflowIds !== undefined && workflowIds.length > 0 && runsQ.data === undefined);
  const feedError = childrenQ.error ?? workflowsQ.error ?? runsQ.error;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
        {/* Header */}
        <header className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-words font-display text-2xl text-ink">{team?.name ?? "Team"}</h1>
            {team && (
              <Badge variant="neutral">
                {team.memberCount} member{team.memberCount === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
          <Link to="/chat" search={{ workspace: teamId }} className="text-sm text-moss underline-offset-2 hover:underline">Open threads</Link>
        </header>

        <TeamSlackSetupCard key={teamId} teamId={teamId} />

        {/* Activity feed */}
        <section aria-label="Team activity" className="space-y-3">
          <h2 className="font-display text-base text-ink">Activity</h2>
          {feedError != null ? (
            <div className="space-y-2">
              <ErrorRow>Could not load team activity: {errorText(feedError)}</ErrorRow>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void childrenQ.refetch?.();
                  void workflowsQ.refetch?.();
                  void runsQ.refetch?.();
                }}
              >
                Retry
              </Button>
            </div>
          ) : feedLoading ? (
            <LoadingRow label="Loading activity…" />
          ) : feed.length === 0 ? (
            <p className="rounded-lg border border-line px-4 py-6 text-sm text-muted">
              No agent activity yet. Open the team’s assistant or enable a workflow, and its runs
              land here.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {feed.map((item) => (
                <li key={item.key}>
                  {item.kind === "child-run" ? (
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: item.targetId }}
                      className="flex min-h-11 flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-3 sm:flex-nowrap sm:py-2.5 text-sm hover:bg-ink-wash"
                    >
                      <span className="min-w-0 basis-full break-words text-ink sm:basis-auto sm:flex-1 sm:truncate">
                        <span className="font-medium">{item.actor}</span> ran “{item.title}”
                      </span>
                      <span className={`shrink-0 text-xs ${TONE_CLASS[item.tone]}`}>
                        {item.statusLabel}
                      </span>
                      <span className="shrink-0 text-xs text-muted">
                        {relativeTime(item.createdAt)}
                      </span>
                    </Link>
                  ) : (
                    <Link
                      to="/workflows/runs/$runId"
                      params={{ runId: item.targetId }}
                      className="flex min-h-11 flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-3 sm:flex-nowrap sm:py-2.5 text-sm hover:bg-ink-wash"
                    >
                      <span className="min-w-0 basis-full break-words text-ink sm:basis-auto sm:flex-1 sm:truncate">
                        <span className="font-medium">{item.title}</span> workflow run
                      </span>
                      <span className={`shrink-0 text-xs ${TONE_CLASS[item.tone]}`}>
                        {item.statusLabel}
                      </span>
                      <span className="shrink-0 text-xs text-muted">
                        {relativeTime(item.createdAt)}
                      </span>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Cards */}
        <div className="grid gap-4 md:grid-cols-2">
          <WorkflowsCard
            count={workflowsQ.data?.workflows.length}
            runs={runsQ.data?.runs}
            error={workflowsQ.error}
          />
          <TeamUsageCard teamId={teamId} />
          <TeamArtifactsCard teamId={teamId} />
          <TeamMemoryCard teamId={teamId} />
        </div>
      </div>
    </div>
  );
}

// ── cards ──────────────────────────────────────────────────────────────────

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

function WorkflowsCard({
  count,
  runs,
  error,
}: {
  count: number | undefined;
  runs: readonly GlobalWorkflowRunSummary[] | undefined;
  error: Error | null;
}) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const runsToday = (runs ?? []).filter((r) => r.createdAt >= Date.now() - DAY_MS).length;
  // One page (200) is the count's horizon; past it, say so instead of
  // reporting a silently capped number.
  const runsTodaySaturated = runs !== undefined && runsToday === runs.length && runs.length >= 200;
  return (
    <CardShell title="Workflows" link={{ to: "/workflows", label: "View workflows →" }}>
      {error != null ? (
        <ErrorRow>Could not load workflows: {errorText(error)}</ErrorRow>
      ) : count === undefined ? (
        <LoadingRow />
      ) : count === 0 ? (
        <p className="text-sm text-muted">No workflows yet. Create one from the Workflows page.</p>
      ) : (
        <div className="flex flex-wrap gap-6 text-sm text-ink">
          <div>
            <div className="font-display text-xl">{count}</div>
            <div className="text-xs text-muted">workflow{count === 1 ? "" : "s"}</div>
          </div>
          <div>
            <div className="font-display text-xl">{runsTodaySaturated ? "200+" : runsToday}</div>
            <div className="text-xs text-muted">runs in 24h</div>
          </div>
        </div>
      )}
    </CardShell>
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

function TeamArtifactsCard({ teamId }: { teamId: string }) {
  const artifactsQ = useArtifacts({ ownerType: "team", ownerId: teamId });
  const items = artifactsQ.data?.artifacts.filter((a) => !a.revoked).slice(0, 5);
  return (
    <CardShell title="Artifacts">
      {artifactsQ.error != null ? (
        <ErrorRow>Could not load artifacts: {errorText(artifactsQ.error)}</ErrorRow>
      ) : items === undefined ? (
        <LoadingRow />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing shared yet. Ask the team’s assistant to share a memory file as an artifact.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((a) => (
            <li key={a.id} className="flex items-baseline gap-2 text-sm">
              {/* In-app route by token, NOT `a.url`: url's origin is the
                  deployment's public URL, which in dev is the api origin —
                  a dead link for the SPA page. */}
              <Link
                to="/a/$token"
                params={{ token: a.token }}
                className="block min-h-11 min-w-0 flex-1 break-words py-3 text-ink underline-offset-2 sm:min-h-0 sm:truncate sm:py-0 hover:underline"
              >
                {a.title || a.path}
              </Link>
              <span className="shrink-0 text-xs text-muted">{relativeTime(a.updatedAt)}</span>
            </li>
          ))}
        </ul>
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
