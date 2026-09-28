import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, type OwnerFilter } from "~/api/client";
import { qkCatchUp } from "~/api/catch-up";
import { Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { WorkspaceCatchUp } from "~/components/dashboard/workspace-catch-up";

export function WorkDiscovery() {
  return <div className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
    <header><h1 className="font-display text-2xl">Briefing</h1><p className="mt-1 text-sm text-muted">The latest on your goals, decisions, and results.</p></header>
    <WorkspaceCatchUp />
  </div></div>;
}

export function WorkArtifacts({ owner, sessionId, threadId }: { owner: OwnerFilter; sessionId: string; threadId?: string }) {
  const [open, setOpen] = useState(false);
  const artifacts = useInfiniteQuery({
    queryKey: qkCatchUp.workArtifacts(owner, sessionId, threadId),
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
