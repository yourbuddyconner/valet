import { createFileRoute, Link } from "@tanstack/react-router";
import type { ArtifactListItem } from "@valet/api/wire";
import { useState } from "react";
import { useListOwner } from "~/lib/use-list-owner";
import { useMe } from "~/api/settings";
import { Pager } from "~/components/pager";
import { currentCursor, pageNumber, popCursor, pushCursor } from "~/lib/cursor-stack";
import type { OwnerFilter } from "~/api/client";
import { useArtifacts, useRevokeArtifact } from "~/api/artifacts";
import { ConfirmDialog, EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { relativeTime } from "~/lib/relative-time";
import { useCopyToClipboard } from "~/lib/use-copy";

/**
 * `/artifacts` — the selected workspace's gallery (memory docs and
 * agent-generated snapshots alike; see the artifacts design). Revoked
 * artifacts are filtered out: a revoked link is a dead link, not a row to
 * manage from here.
 *
 * The workspace owner selects the list. The keyed child resets pagination
 * and row dialogs before a different workspace issues its first request.
 *
 * Rows link in-app with `token` (`/a/$token`), never `url` — `url` is the
 * absolute share link, whose origin is the deployment's public URL, which
 * in dev is the api origin and does not serve the SPA. `url` is correct
 * only for the clipboard copy.
 */
export const Route = createFileRoute("/artifacts/")({ component: ArtifactsPage });

export function ArtifactsPage() {
  const owner = useListOwner();
  const me = useMe();
  if (!owner) {
    return me.error
      ? <ErrorRow>Could not load your workspace. Reload to try again.</ErrorRow>
      : <LoadingRow label="Loading artifacts…" />;
  }
  return <ScopedArtifactsPage key={`${owner.ownerType}:${owner.ownerId}`} owner={owner} />;
}

function ScopedArtifactsPage({ owner }: { owner: OwnerFilter }) {
  const me = useMe();
  const [cursors, setCursors] = useState<string[]>([]);
  const listQ = useArtifacts(owner, { limit: 50, cursor: currentCursor(cursors) });
  const loading = listQ.isLoading;
  const artifacts = (listQ.data?.artifacts ?? []).filter((a) => !a.revoked);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <h1 className="font-display text-2xl text-ink">Artifacts</h1>
        <p className="mt-1 text-sm text-muted">
          {owner.ownerType === "team"
            ? "Team-only pages. Only current members of this team can open these links."
            : "Pages published in this workspace. A link serves logged-in members of your org unless it is public."}
        </p>

        <div className="mt-6">
          {loading && <LoadingRow label="Loading artifacts…" />}
          {listQ.error && (
            <ErrorRow>Could not load artifacts for this workspace. Check your access, then reload.</ErrorRow>
          )}
          {!loading && !listQ.error && listQ.data && artifacts.length === 0 && (
            <EmptyRow>Nothing published yet. Ask your agent to publish a page, or share a memory doc.</EmptyRow>
          )}
          {!loading && !listQ.error && artifacts.length > 0 && (
            <div className="divide-y divide-line border-t border-line">
              {artifacts.map((artifact) => (
                <ArtifactRow key={artifact.id} artifact={artifact} canManage={!me.error && (me.data?.orgRole === "admin" || me.data?.id === artifact.actorUserId)} />
              ))}
            </div>
          )}
          {!loading && !listQ.error && (
            <Pager
              label="artifacts"
              page={pageNumber(cursors)}
              hasPrevious={cursors.length > 0}
              hasNext={listQ.data?.nextCursor != null}
              onPrevious={() => setCursors(popCursor(cursors))}
              onNext={() => {
                const next = listQ.data?.nextCursor;
                if (next) setCursors(pushCursor(cursors, next));
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ArtifactRow({ artifact, canManage }: { artifact: ArtifactListItem; canManage: boolean }) {
  // Per-row instance: `useCopyToClipboard`'s "Copied" flash is component
  // state, and each row needs its own so copying one doesn't flash every
  // row in the list.
  const { copied, copy } = useCopyToClipboard();
  // Also per-row (`workflows.index.tsx`'s `DefinitionRow` pattern): a
  // shared mutation would disable and error every row in the list for one
  // revoke, instead of just the row the caller acted on.
  const revoke = useRevokeArtifact();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  return (
    <div className="py-2.5">
      <div className="flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Link
          to="/a/$token"
          params={{ token: artifact.token }}
          className="min-w-0 flex-1 rounded px-1 py-0.5 max-sm:min-h-11 hover:bg-ink-wash"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden>{artifact.icon}</span>
            <span className="min-w-0 flex-1 break-words text-sm text-ink sm:truncate">{artifact.title}</span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
            <span>{artifact.format}</span>
            <span>·</span>
            <span>version {artifact.sharedVersion ?? artifact.version}</span>
            <span>·</span>
            {artifact.ownerType === "team" ? (
              <span>Team-only</span>
            ) : artifact.visibility === "public" ? (
              <span className="rounded bg-ink-wash px-1.5 py-0.5">public</span>
            ) : (
              <span>{artifact.visibility}</span>
            )}
            <span>·</span>
            <span>updated {relativeTime(artifact.updatedAt)}</span>
          </p>
        </Link>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {artifact.sourceSessionId && <Link to="/sessions/$sessionId" params={{ sessionId: artifact.sourceSessionId }} search={{ thread: artifact.sourceThreadId ?? undefined }} className="text-xs underline">Open originating work</Link>}
          <button
            type="button"
            onClick={() => void copy(artifact.url)}
            className="max-sm:min-h-11 max-sm:px-2 text-xs text-muted hover:text-ink"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          {canManage && <button
            type="button"
            disabled={revoke.isPending}
            onClick={() => {
              // React Query holds `error` until the next mutate, and Radix
              // never calls `onOpenChange(true)` for a controlled dialog with
              // no trigger, so the previous refusal is cleared here instead.
              revoke.reset();
              setConfirmRevoke(true);
            }}
            className="max-sm:min-h-11 max-sm:px-2 text-xs text-danger-500 hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            {revoke.isPending ? "Revoking…" : "Revoke"}
          </button>}
        </div>
      </div>
      {/* A failed revoke reports in BOTH places on purpose. The dialog
          stays open so the caller reads the reason beside the button that
          produced it; the row keeps the message after the dialog is
          dismissed, because a link the caller believes is revoked and is
          not is a disclosure they must still be able to see. */}
      {revoke.error != null && !confirmRevoke && (
        <p className="mt-1 text-xs text-danger-500">{errorText(revoke.error)}</p>
      )}
      {canManage && <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title={`Revoke the link to ${artifact.title}?`}
        description="Anyone who opens the link gets a 404, and the page leaves this gallery. Publish it again to get a new link."
        confirmLabel="Revoke"
        pendingLabel="Revoking…"
        pending={revoke.isPending}
        error={revoke.error != null ? errorText(revoke.error) : undefined}
        onConfirm={() =>
          revoke.mutate({ id: artifact.id }, { onSuccess: () => setConfirmRevoke(false) })
        }
      />}
    </div>
  );
}
