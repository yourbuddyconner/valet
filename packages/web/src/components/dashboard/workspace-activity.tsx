import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FileText, GitPullRequest, MessageSquare, ArrowUpRight, CircleAlert, LoaderCircle, CheckCheck } from "lucide-react";
import type { ArtifactListItem, GlobalWorkflowRunSummary, SessionSummary, WorkspaceOutcome, WorkspaceActiveWorkItem } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";
import { useCatchUpWork, useWorkspaceOutcomes, useWorkspaceActiveWork } from "~/api/catch-up";
import { useArtifacts } from "~/api/artifacts";
import { useRuns, useWorkflows, useWorkflowActionRequired } from "~/api/workflows";
import { useMe } from "~/api/settings";
import { useListOwner } from "~/lib/use-list-owner";
import { relativeTime } from "~/lib/relative-time";
import { Badge, Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { RunStateBadge } from "~/components/run-state-badge";

export function WorkspaceActivity({ owner: explicitOwner }: { owner?: OwnerFilter }) {
  const selectedOwner = useListOwner();
  const me = useMe();
  const owner = explicitOwner ?? selectedOwner;
  if (me.error && (!owner || owner.ownerType === "user")) return <ErrorRow>Could not load your workspace. Reload to try again.</ErrorRow>;
  if (!owner) return <LoadingRow label="Loading work…" />;
  return <ScopedCatchUp key={`${owner.ownerType}:${owner.ownerId}`} owner={owner} />;
}

export function safeResultUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

export function runCategory(run: GlobalWorkflowRunSummary): "attention" | "progress" | "result" {
  if (run.needsApproval || run.outcome === "failed") return "attention";
  return run.status === "settled" ? "result" : "progress";
}

type ResultItem = {
  id: string; title: string; kind: string; time: number;
  sessionId?: string; threadId?: string; runId?: string; token?: string; url?: string;
};

export function groupResults(items: ResultItem[]): ResultItem[][] {
  const groups = new Map<string, ResultItem[]>();
  for (const item of [...items].sort((a, b) => b.time - a.time)) {
    const key = item.runId ? `run:${item.runId}` : item.sessionId ? `session:${item.sessionId}` : item.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()];
}

function outcomeResult(row: WorkspaceOutcome): ResultItem {
  return { id: `outcome:${row.id}`, title: row.title, kind: row.kind, time: row.occurredAt,
    sessionId: row.sessionId, threadId: row.threadId, runId: row.workflowRunId, url: safeResultUrl(row.url) };
}
function artifactResult(row: ArtifactListItem): ResultItem {
  return { id: `artifact:${row.id}`, title: row.title || row.path, kind: "artifact", time: row.updatedAt,
    sessionId: row.sourceSessionId ?? undefined, threadId: row.sourceThreadId ?? undefined, token: row.token };
}

function ScopedCatchUp({ owner }: { owner: OwnerFilter }) {
  const work = useCatchUpWork(owner);
  const activeWork = useWorkspaceActiveWork(owner);
  const outcomes = useWorkspaceOutcomes(owner);
  const [artifactCursor, setArtifactCursor] = useState<string>();
  const [activeCursor, setActiveCursor] = useState<string>();
  const [recentCursor, setRecentCursor] = useState<string>();
  const artifacts = useArtifacts(owner, { limit: 25, cursor: artifactCursor, refetchInterval: 10_000 });
  const workflows = useWorkflows(owner);
  const gates = useWorkflowActionRequired();
  const workflowIds = workflows.error ? undefined : workflows.data?.workflows.map(row => row.id);
  const active = useRuns({ workflowIds: workflowIds ?? [], status: ["pending", "running", "parked", "terminalizing"], limit: 100, cursor: activeCursor },
    { enabled: workflowIds !== undefined, refetchInterval: 10_000 });
  const recent = useRuns({ workflowIds: workflowIds ?? [], status: ["settled"], limit: 25, cursor: recentCursor },
    { enabled: workflowIds !== undefined, refetchInterval: 10_000 });
  const sessions = work.error ? [] : work.data?.pages.flatMap(page => page.sessions) ?? [];
  const runs = workflows.error ? [] : [...(active.error ? [] : active.data?.runs ?? []), ...(recent.error ? [] : recent.data?.runs ?? [])];
  const queueItems = activeWork.error ? [] : activeWork.data?.pages.flatMap(page => page.items) ?? [];
  const statePriority = { needs_you: 3, working: 2, failed: 1 };
  const activeThreadMap = new Map<string, WorkspaceActiveWorkItem>();
  for (const row of queueItems) {
    const key = `${row.sessionId}:${row.threadId}`;
    const existing = activeThreadMap.get(key);
    if (!existing || statePriority[row.state] > statePriority[existing.state] || (row.state === existing.state && row.updatedAt > existing.updatedAt)) activeThreadMap.set(key, row);
  }
  const activeThreads = [...activeThreadMap.values()];
  const needsYou = activeThreads.filter(row => row.state === "needs_you" || row.state === "failed");
  const inProgress = activeThreads.filter(row => row.state === "working");
  const attentionRuns = runs.filter(row => runCategory(row) === "attention");
  const progressRuns = runs.filter(row => runCategory(row) === "progress");
  const resultItems: ResultItem[] = [
    ...(outcomes.error ? [] : outcomes.data?.pages.flatMap(page => page.items).map(outcomeResult) ?? []),
    ...(artifacts.error ? [] : artifacts.data?.artifacts.filter(row => !row.revoked).map(artifactResult) ?? []),
    ...runs.filter(row => runCategory(row) === "result").map(row => ({ id: `run:${row.runId}`, title: row.workflowName, kind: row.outcome ?? "settled", time: row.updatedAt, runId: row.runId })),
  ];
  const otherWork = sessions.filter(row => !activeThreads.some(item => item.sessionId === row.id) && !resultItems.some(item => item.sessionId === row.id));
  const loading = activeWork.isPending || workflows.isPending || gates.isPending || (workflowIds !== undefined && (active.isPending || recent.isPending));
  const errors = [
    { label: "work", query: work }, { label: "active work", query: activeWork }, { label: "results", query: outcomes }, { label: "artifacts", query: artifacts },
    { label: "workflows", query: workflows }, { label: "approval details", query: gates },
    ...(workflowIds !== undefined ? [{ label: "active workflow runs", query: active }, { label: "recent workflow runs", query: recent }] : []),
  ].filter(entry => entry.query.error);
  const incomplete = (!activeWork.error && activeWork.hasNextPage) || (!active.error && !workflows.error && (active.data?.nextCursor || activeCursor));
  return <div className="space-y-7">
    {errors.map(({ label, query }) => <ErrorRow key={label}>Could not load {label}. <button className="underline" onClick={() => void query.refetch()}>Retry</button></ErrorRow>)}
    {loading && <LoadingRow label="Loading work…" />}
    {incomplete && <p className="text-xs text-muted">More active work is available. Use the paging controls below to see it.</p>}
    <Section title="Needs attention" icon={<CircleAlert className="h-4 w-4 text-amber" />} count={needsYou.length + attentionRuns.length}>
      {needsYou.map(row => <ActiveRow key={row.id} row={row} />)}
      {attentionRuns.map(row => <RunRow key={row.runId} row={row} prompt={gates.error ? undefined : gates.data?.items.find(item => item.runId === row.runId && item.owner.type === owner.ownerType && item.owner.id === owner.ownerId)?.gate.prompt} />)}
      {!loading && !activeWork.error && !workflows.error && !active.error && !recent.error && !gates.error && needsYou.length + attentionRuns.length === 0 && <p className="px-4 py-4 text-sm text-muted">No attention items in the loaded work.</p>}
    </Section>
    <Section title="In progress" icon={<LoaderCircle className="h-4 w-4 text-moss" />} count={inProgress.length + progressRuns.length}>
      {inProgress.map(row => <ActiveRow key={row.id} row={row} />)}
      {progressRuns.map(row => <RunRow key={row.runId} row={row} />)}
      {!loading && !activeWork.error && !workflows.error && !active.error && inProgress.length + progressRuns.length === 0 && <p className="px-4 py-4 text-sm text-muted">No active work in the loaded results.</p>}
    </Section>
    {!activeWork.error && activeWork.hasNextPage && <Button variant="secondary" size="sm" disabled={activeWork.isFetchingNextPage} onClick={() => void activeWork.fetchNextPage()}>Load more active work</Button>}
    {!active.error && !workflows.error && <PageControls cursor={activeCursor} next={active.data?.nextCursor} onPage={setActiveCursor} label="active runs" />}
    <Section title="Recent results" icon={<CheckCheck className="h-4 w-4 text-moss" />} count={resultItems.length}>
      {(outcomes.isPending || artifacts.isPending || (workflowIds !== undefined && recent.isPending)) && <LoadingRow label="Loading results…" />}
      {groupResults(resultItems).map(group => {
        const first = group[0]!;
        const session = sessions.find(row => row.id === first.sessionId);
        return <div key={first.id} className="px-4 py-4">
          {session && <div className="mb-3 flex flex-wrap items-center gap-2"><Link to="/sessions/$sessionId" params={{ sessionId: session.id }} className="text-sm font-medium hover:underline">{session.title || "Untitled work"}</Link><RunStateBadge state={session.runState} /></div>}
          <ul className="space-y-3">{group.map(item => <ResultRow key={item.id} item={item} />)}</ul>
        </div>;
      })}
      {!outcomes.isPending && !artifacts.isPending && !recent.isPending && !outcomes.error && !artifacts.error && !recent.error && !workflows.error && !resultItems.length && <p className="px-4 py-5 text-sm text-muted">No results yet. Published files, pull requests, and workflow results will appear here.</p>}
    </Section>
    <div className="flex flex-wrap gap-3">
      {!outcomes.error && outcomes.hasNextPage && <Button size="sm" variant="secondary" disabled={outcomes.isFetchingNextPage} onClick={() => void outcomes.fetchNextPage()}>Load more results</Button>}
      {!artifacts.error && <PageControls cursor={artifactCursor} next={artifacts.data?.nextCursor} onPage={setArtifactCursor} label="artifacts" />}
      {!recent.error && !workflows.error && <PageControls cursor={recentCursor} next={recent.data?.nextCursor} onPage={setRecentCursor} label="workflow results" />}
    </div>
    {(otherWork.length > 0 || work.hasNextPage) && <details><summary className="cursor-pointer text-sm text-muted">Recent work · {otherWork.length} loaded</summary><div className="mt-3"><Section title="Recent work" count={otherWork.length}><p className="px-4 py-3 text-xs text-muted">Idle and sleeping work may still have unfinished tasks. Open the conversation to check.</p>{otherWork.map(row => <SessionRow key={row.id} row={row} />)}</Section>    {!work.error && work.hasNextPage && <Button variant="secondary" size="sm" disabled={work.isFetchingNextPage} onClick={() => void work.fetchNextPage()}>Load more work</Button>}
</div></details>}
  </div>;
}

function Section({ title, count, icon, children }: { title: string; count: number; icon?: ReactNode; children: ReactNode }) {
  return <section aria-label={title}><div className="mb-3 flex items-center gap-2">{icon}<h2 className="font-display text-lg">{title}</h2><span className="text-xs text-muted">{count}</span></div><div className="divide-y divide-line rounded-lg border border-line bg-paper">{children}</div></section>;
}
function ActiveRow({ row }: { row: WorkspaceActiveWorkItem }) {
  return <div className="flex flex-wrap items-center gap-3 px-4 py-3"><Link to="/sessions/$sessionId" params={{ sessionId: row.sessionId }} search={{ thread: row.threadId }} className="min-w-0 flex-1 break-words text-sm font-medium hover:underline">{row.title || "Untitled thread"}</Link><RunStateBadge state={row.state} /><span className="text-xs text-muted">{relativeTime(row.updatedAt)}</span></div>;
}
function SessionRow({ row }: { row: SessionSummary }) {
  return <div className="flex flex-wrap items-center gap-3 px-4 py-3"><Link to="/sessions/$sessionId" params={{ sessionId: row.id }} className="min-w-0 flex-1 break-words text-sm font-medium hover:underline">{row.title || "Untitled work"}</Link><RunStateBadge state={row.runState} /><span className="text-xs text-muted">{relativeTime(row.lastActivityAt)}</span></div>;
}
function RunRow({ row, prompt }: { row: GlobalWorkflowRunSummary; prompt?: string }) {
  const label = row.needsApproval ? "Approval needed" : row.outcome === "failed" ? "Failed" : row.status === "parked" ? "Waiting" : row.status === "pending" ? "Queued" : row.status === "terminalizing" ? "Finishing" : "Running";
  return <div className="px-4 py-3"><div className="flex flex-wrap items-center gap-3"><Link to="/workflows/runs/$runId" params={{ runId: row.runId }} className="min-w-0 flex-1 break-words text-sm font-medium hover:underline">{row.workflowName}</Link><Badge variant={runCategory(row) === "attention" ? "warning" : "neutral"}>{label}</Badge><span className="text-xs text-muted">{relativeTime(row.updatedAt)}</span></div>{prompt && <p className="mt-2 text-sm text-muted">{prompt}</p>}</div>;
}
function ResultRow({ item }: { item: ResultItem }) {
  const Icon = item.kind === "pull_request" ? GitPullRequest : item.kind === "message" ? MessageSquare : FileText;
  const label = item.kind === "pull_request" ? "Pull request" : item.kind === "artifact" ? "Published file" : item.kind === "review" ? "Review" : item.kind === "message" ? "Message" : item.kind === "completed" ? "Workflow completed" : item.kind === "cancelled" ? "Workflow cancelled" : "Workflow settled";
  return <li className="flex gap-3"><Icon aria-hidden className="mt-1 h-4 w-4 shrink-0 text-moss" /><div className="min-w-0 flex-1">
    {item.token ? <Link to="/a/$token" params={{ token: item.token }} className="break-words text-sm font-medium hover:underline">{item.title}</Link> : item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-words text-sm font-medium hover:underline">{item.title}<ArrowUpRight className="h-3 w-3 shrink-0" /></a> : <span className="break-words text-sm font-medium">{item.title}</span>}
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted"><span>{label}</span><span>{relativeTime(item.time)}</span>
      {item.sessionId && <Link to="/sessions/$sessionId" params={{ sessionId: item.sessionId }} search={{ thread: item.threadId }} className="text-moss hover:underline">{item.threadId ? "Open thread" : "Open work"}</Link>}
      {item.runId && <Link to="/workflows/runs/$runId" params={{ runId: item.runId }} className="text-moss hover:underline">Open workflow run</Link>}
    </div>
  </div></li>;
}
function PageControls({ cursor, next, onPage, label }: { cursor?: string; next?: string | null; onPage: (cursor?: string) => void; label: string }) {
  return <div className="flex gap-2">{cursor && <Button size="sm" variant="ghost" onClick={() => onPage(undefined)}>Latest {label}</Button>}{next && <Button size="sm" variant="secondary" onClick={() => onPage(next)}>Next {label}</Button>}</div>;
}
