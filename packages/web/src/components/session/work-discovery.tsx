import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, type OwnerFilter } from "~/api/client";
import { useMe } from "~/api/settings";
import { useListOwner } from "~/lib/use-list-owner";
import { Button, EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { NewSessionDialog } from "~/components/new-session-dialog";
import { RunStateBadge } from "~/components/run-state-badge";
import { relativeTime } from "~/lib/relative-time";

/** Work keeps its own runtime; Threads supplies the workspace discovery surface. */
export function WorkDiscovery() {
  const owner = useListOwner();
  const me = useMe();
  if (!owner) return me.error
    ? <ErrorRow>Could not load your workspace. Reload to try again.</ErrorRow>
    : <LoadingRow label="Loading work…" />;
  return <ScopedWork key={`${owner.ownerType}:${owner.ownerId}`} owner={owner} />;
}

function ScopedWork({ owner }: { owner: OwnerFilter }) {
  const [newOpen, setNewOpen] = useState(false);
  const work = useInfiniteQuery({
    queryKey: ["workspace-work", owner.ownerType, owner.ownerId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listWork(owner, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const rows = work.error ? [] : work.data?.pages.flatMap(page => page.sessions) ?? [];
  return <div className="flex-1 overflow-y-auto p-4 sm:p-6">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h1 className="text-lg font-semibold">Work and artifacts</h1>
      <Button size="sm" onClick={() => setNewOpen(true)}>New work</Button>
    </div>
    <p className="mb-4 text-sm text-muted">Standalone work and child executions in this workspace, newest first.</p>
    <Link to="/artifacts" className="text-sm underline">All workspace artifacts</Link>
    {work.isLoading && <LoadingRow label="Loading work…" />}
    {work.error && <ErrorRow>Could not load work. <button onClick={() => void work.refetch()} className="underline">Retry</button></ErrorRow>}
    {!work.isLoading && !work.error && rows.length === 0 && <EmptyRow>No work yet. Select New work to start.</EmptyRow>}
    <ul className="mt-4 space-y-3">
      {rows.map(row => <li key={row.id} className="rounded border border-line p-3">
        <Link to="/sessions/$sessionId" params={{ sessionId: row.id }} className="flex items-center gap-3 hover:underline">
          <span className="min-w-0 flex-1 truncate font-medium">{row.title || "Untitled work"}</span>
          <RunStateBadge state={row.runState} />
        </Link>
        <p className="mt-1 text-xs text-muted">{row.status === "archived" ? "Archived · " : ""}{relativeTime(row.lastActivityAt)}</p>
        <WorkArtifacts owner={owner} sessionId={row.id} />
      </li>)}
    </ul>
    {!work.error && work.hasNextPage && <Button className="mt-4" variant="secondary" disabled={work.isFetchingNextPage} onClick={() => void work.fetchNextPage()}>
      {work.isFetchingNextPage ? "Loading…" : "Load more work"}
    </Button>}
    <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} />
  </div>;
}

export function WorkArtifacts({ owner, sessionId, threadId }: { owner: OwnerFilter; sessionId: string; threadId?: string }) {
  const [open, setOpen] = useState(false);
  const artifacts = useInfiniteQuery({
    queryKey: ["artifacts", "work", owner.ownerType, owner.ownerId, sessionId, threadId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listArtifacts(owner, { sourceSessionId: sessionId, ...(threadId ? { sourceThreadId: threadId } : {}), limit: 10, cursor: pageParam }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: open,
    refetchInterval: open ? 10_000 : false,
  });
  const rows = artifacts.error ? [] : artifacts.data?.pages.flatMap(page => page.artifacts) ?? [];
  return <div className="mt-2 text-sm">
    <button className="underline" aria-expanded={open} onClick={() => setOpen(!open)}>{threadId ? "Artifacts from this thread" : "Artifacts from this work"}</button>
    {open && <div className="mt-2">
      {artifacts.isLoading && <LoadingRow label="Loading artifacts…" />}
      {artifacts.error && <ErrorRow>Could not load artifacts. <button className="underline" onClick={() => void artifacts.refetch()}>Retry</button></ErrorRow>}
      {!artifacts.isLoading && !artifacts.error && rows.length === 0 && <p className="text-muted">No published artifacts from this work.</p>}
      <ul>{rows.map(artifact => <li key={artifact.id}><Link className="underline" to="/a/$token" params={{ token: artifact.token }}>{artifact.title}</Link></li>)}</ul>
      {!artifacts.error && artifacts.hasNextPage && <button className="mt-2 underline" disabled={artifacts.isFetchingNextPage} onClick={() => void artifacts.fetchNextPage()}>Load more artifacts</button>}
    </div>}
  </div>;
}
