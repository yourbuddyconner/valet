import { useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, FileText, GitPullRequest, MessageSquare, Workflow } from "lucide-react";
import type { WorkspaceBriefing, WorkspaceBriefingSource } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";
import { useWorkspaceBriefings } from "~/api/catch-up";
import { useMe } from "~/api/settings";
import { useListOwner } from "~/lib/use-list-owner";
import { relativeTime } from "~/lib/relative-time";
import { Badge, Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { WorkspaceActivity, safeResultUrl } from "./workspace-activity";

export function WorkspaceCatchUp({ owner: explicitOwner }: { owner?: OwnerFilter }) {
  const selectedOwner = useListOwner();
  const me = useMe();
  const owner = explicitOwner ?? selectedOwner;
  if (me.error && (!owner || owner.ownerType === "user")) {
    return <ErrorRow>Could not load your workspace. Reload to try again.</ErrorRow>;
  }
  if (!owner) return <LoadingRow label="Preparing your briefing…" />;
  return <ScopedBriefings key={`${owner.ownerType}:${owner.ownerId}`} owner={owner} />;
}

function ScopedBriefings({ owner }: { owner: OwnerFilter }) {
  const briefings = useWorkspaceBriefings(owner);
  const [showActivity, setShowActivity] = useState(false);
  return <div className="space-y-6">
    {briefings.isError ? (
      <ErrorRow>Could not prepare your briefing. <button className="underline" onClick={() => void briefings.refetch()}>Retry</button></ErrorRow>
    ) : briefings.isPending ? (
      <LoadingRow label="Preparing your briefing…" />
    ) : briefings.data.unavailable ? (
      <div className="space-y-3 rounded-lg border border-line p-5">
        <p className="text-sm text-muted">Your briefing is unavailable. Retry to prepare it from your recent work.</p>
        <Button variant="secondary" size="sm" disabled={briefings.isFetching} onClick={() => void briefings.refetch()}>Retry</Button>
      </div>
    ) : briefings.data.briefings.length === 0 ? (
      <p className="rounded-lg border border-line px-5 py-6 text-sm text-muted">No recent work to brief yet. Your goals and results will appear here as you work.</p>
    ) : (
      <div className="space-y-4">
        {briefings.data.briefings.map(briefing => <BriefingCard key={briefing.id} briefing={briefing} />)}
        <p className="text-xs text-muted">Based on recent work{briefings.data.generatedAt ? ` · Prepared ${relativeTime(briefings.data.generatedAt)}` : ""}</p>
      </div>
    )}
    <details onToggle={event => setShowActivity(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-muted hover:text-ink">Activity details</summary>
      {showActivity && <div className="mt-5"><WorkspaceActivity owner={owner} /></div>}
    </details>
  </div>;
}

const STATUS: Record<WorkspaceBriefing["status"], { label: string; variant: "warning" | "accent" | "neutral" }> = {
  needs_attention: { label: "Needs attention", variant: "warning" },
  in_progress: { label: "In progress", variant: "accent" },
  updated: { label: "Updated", variant: "neutral" },
};

function BriefingCard({ briefing }: { briefing: WorkspaceBriefing }) {
  const headingId = useId();
  const status = STATUS[briefing.status];
  const sources = briefing.sources;
  return <article aria-labelledby={headingId} className="rounded-xl border border-line bg-paper p-5 sm:p-6">
    <header className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={headingId} className="min-w-0 flex-1 break-words font-display text-xl text-ink">{briefing.title}</h2>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <p className="text-sm leading-relaxed text-muted">{briefing.context}</p>
    </header>
    <p className="whitespace-pre-line text-base leading-relaxed text-ink">{briefing.summary}</p>
    {briefing.nextStep && <div className="mt-4 rounded-lg bg-ink-wash px-4 py-3">
      <p className="mb-1 text-xs font-semibold text-ink">Next step</p>
      <p className="text-sm leading-relaxed text-ink">{briefing.nextStep}</p>
    </div>}
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      {briefing.latestThread ? <Link
        to="/sessions/$sessionId"
        params={{ sessionId: briefing.latestThread.sessionId }}
        search={{ thread: briefing.latestThread.threadId }}
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-moss underline-offset-4 hover:underline sm:min-h-0"
      >Continue in latest thread <ArrowRight aria-hidden className="h-4 w-4" /></Link> : <span className="text-sm text-muted">No linked conversation</span>}
      <span className="text-xs text-muted">Updated {relativeTime(briefing.updatedAt)}</span>
    </div>
    {sources.length > 0 && <div className="mt-4 border-t border-line pt-3">
      <ul aria-label="Sources" className="flex flex-wrap gap-2">
        {sources.slice(0, 3).map(source => <BriefingSource key={source.id} source={source} />)}
      </ul>
      {sources.length > 3 && <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted hover:text-ink">{sources.length - 3} more {sources.length === 4 ? "source" : "sources"}</summary>
        <ul aria-label="More sources" className="mt-2 flex flex-wrap gap-2">
          {sources.slice(3).map(source => <BriefingSource key={source.id} source={source} />)}
        </ul>
      </details>}
    </div>}
  </article>;
}

function BriefingSource({ source }: { source: WorkspaceBriefingSource }) {
  const Icon = source.kind === "pull_request" ? GitPullRequest : source.kind === "workflow" ? Workflow : source.kind === "artifact" ? FileText : MessageSquare;
  const className = "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-ink-wash hover:text-ink";
  const content = <><Icon aria-hidden className="h-3.5 w-3.5 shrink-0" /><span className="break-words">{source.title}</span></>;
  const url = safeResultUrl(source.url);
  return <li className="min-w-0 max-w-full">
    {source.token ? <Link to="/a/$token" params={{ token: source.token }} className={className}>{content}</Link>
      : source.kind === "thread" && source.sessionId && source.threadId ? <Link to="/sessions/$sessionId" params={{ sessionId: source.sessionId }} search={{ thread: source.threadId }} className={className}>{content}</Link>
      : url ? <a href={url} target="_blank" rel="noopener noreferrer" className={className}>{content}<ArrowUpRight aria-hidden className="h-3 w-3 shrink-0" /></a>
      : source.runId ? <Link to="/workflows/runs/$runId" params={{ runId: source.runId }} className={className}>{content}</Link>
      : source.sessionId && source.threadId ? <Link to="/sessions/$sessionId" params={{ sessionId: source.sessionId }} search={{ thread: source.threadId }} className={className}>{content}</Link>
      : <span className="inline-flex max-w-full items-center gap-1.5 px-2 py-1 text-xs text-muted">{content}</span>}
  </li>;
}
