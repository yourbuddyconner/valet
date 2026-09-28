import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Download, MessageSquare, MessageSquarePlus } from "lucide-react";
import { buildArtifactDocument, type ArtifactAnchorRect } from "@valet/shared";
import {
  useAddArtifactComment,
  useArtifact,
  useArtifactComments,
  useResolveArtifactComment,
} from "~/api/artifacts";
import { ApiError } from "~/api/client";
import { useMe } from "~/api/settings";
import { RevokeArtifact } from "~/components/artifact/revoke-artifact";
import { ArtifactFrame, type ArtifactPick } from "~/components/artifact/artifact-frame";
import {
  ArtifactPins,
  ArtifactThreadPanel,
  CommentComposer,
  groupThreads,
} from "~/components/artifact/artifact-comments";
import { Spinner } from "~/components/primitives";
import { artifactDownloadName, downloadTextFile } from "~/lib/download";
import { relativeTime } from "~/lib/relative-time";
import { useThemeAttribute } from "~/lib/use-theme-attribute";

/**
 * `/a/$token` — the published-page reader (artifact-pages design). Public in
 * the same sense as `/login`: listed in the root layout's public set, so it
 * renders standalone with no signed-in chrome. The API decides who may read:
 * `public` artifacts serve anonymously (org opt-in), `org` ones 401 a
 * signed-out caller — which the api client's central 401 handler turns into
 * a `/login` redirect on real-auth deployments.
 *
 * The body is a publish-time snapshot, rendered in a sandboxed frame
 * (`ArtifactFrame`). Logged-in org readers additionally get the comment
 * layer: pick an element, write a comment in app chrome, optionally send it
 * to the session that published the page.
 */
export const Route = createFileRoute("/a/$token")({
  component: ArtifactPage,
});

export function ArtifactPage() {
  const { token } = Route.useParams();
  const theme = useThemeAttribute();
  const artifactQ = useArtifact(token);
  const canComment = artifactQ.data?.canComment === true;

  const commentsQ = useArtifactComments(token, { enabled: canComment });
  const meQ = useMe({ enabled: canComment });
  const addComment = useAddArtifactComment(token);
  const resolveComment = useResolveArtifactComment(token);

  const [revokedToken, setRevokedToken] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [pendingPick, setPendingPick] = useState<ArtifactPick | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [rects, setRects] = useState<Record<string, ArtifactAnchorRect> | null>(null);

  const threads = useMemo(() => groupThreads(commentsQ.data?.comments ?? []), [commentsQ.data]);
  // Track open-thread anchors AND the in-flight pick: the frame reports
  // fresh rects on its own scroll, and the composer repositions from them —
  // a one-time snapshot would strand the popover on stale coordinates.
  const anchors = useMemo(() => {
    const vdids = threads
      .filter((t) => t.root.vdid !== null && t.root.resolvedAt === null)
      .map((t) => t.root.vdid as string);
    if (pendingPick && !vdids.includes(pendingPick.vdid)) vdids.push(pendingPick.vdid);
    return vdids;
  }, [threads, pendingPick]);
  const openCount = threads.filter((t) => t.root.resolvedAt === null).length;

  // The tab should read as the document, not as the app.
  const title = artifactQ.data?.title;
  const icon = artifactQ.data?.icon;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${icon ? `${icon} ` : ""}${title} · Valet`;
    return () => {
      document.title = previous;
    };
  }, [title, icon]);

  if (revokedToken === token) {
    return <div className="flex min-h-screen items-center justify-center p-8 text-center">
      <div className="space-y-2"><h1 className="font-display text-xl">This link is revoked.</h1><p className="text-sm text-muted">Publish the artifact again to get a new link.</p></div>
    </div>;
  }

  if (artifactQ.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  if (artifactQ.error) {
    const status = artifactQ.error instanceof ApiError ? artifactQ.error.status : undefined;
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center">
        <div className="max-w-sm space-y-2">
          <h1 className="font-display text-xl text-ink">
            {status === 401 ? "This page needs a login." : "This page is unavailable."}
          </h1>
          <p className="text-sm text-muted">
            {status === 401
              ? "Log in with an account that has access to this page."
              : "This page is unavailable or you do not have access. Ask the person who sent the link to check your access."}
          </p>
          {status === 401 && (
            <a
              href={`/login?next=${encodeURIComponent(`/a/${token}`)}`}
              className="inline-block text-sm text-moss hover:underline"
            >
              Go to login
            </a>
          )}
        </div>
      </div>
    );
  }

  const doc = artifactQ.data;
  if (!doc) return null;

  const download = () => {
    if (doc.format === "html") {
      // The shelled document (no comment runtime), so the saved file opens
      // standalone. It carries no viewer theme: the download is
      // deliberately system-themed, so it renders by the reader's own OS
      // preference wherever they open it, not the theme the viewer had
      // active at download time.
      const page = buildArtifactDocument({
        title: doc.title,
        content: doc.rendered,
        description: doc.description || undefined,
        icon: doc.icon || undefined,
      });
      downloadTextFile(artifactDownloadName(doc.title, "html"), page, "text/html");
      return;
    }
    downloadTextFile(artifactDownloadName(doc.title, "md"), doc.content, "text/markdown");
  };

  const submitComment = (opts: { body: string; sendToSession: boolean }) => {
    if (!pendingPick) return;
    addComment.mutate(
      { body: opts.body, vdid: pendingPick.vdid, sendToSession: opts.sendToSession },
      {
        onSuccess: () => {
          setPendingPick(null);
          setPanelOpen(true);
        },
      },
    );
  };

  const authorName = meQ.data?.name || meQ.data?.email || "You";

  return (
    <div className="flex h-screen flex-col">
      {/* One compact bar — the page below is the point; the chrome is not.
          The title/byline collapse to a single truncating row, and the
          description rides in the tooltip instead of a second line. */}
      <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2" title={doc.description || undefined}>
          <h1 className="truncate font-display text-sm font-medium leading-tight text-ink">
            {doc.icon ? `${doc.icon} ` : ""}
            {doc.title}
          </h1>
          {doc.ownerType === "team" && (
            <span className="shrink-0 text-[11px] text-muted" title="Only current members of the owning team can open this link.">Team-only</span>
          )}
          <p className="hidden shrink-0 text-[11px] text-muted sm:block">
            {doc.sharedBy ? `${doc.sharedBy} · ` : ""}v{doc.version} · {relativeTime(doc.updatedAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
            {doc.management && !meQ.error && <RevokeArtifact key={doc.management.id} id={doc.management.id} title={doc.title} token={token} onRevoked={() => setRevokedToken(token)} />}
            {canComment && (
              <button
                type="button"
                onClick={() => {
                  setPicking((p) => !p);
                  setPendingPick(null);
                }}
                className={`flex items-center gap-1 text-xs ${picking ? "text-moss" : "text-muted hover:text-moss"}`}
                title="Click an element on the page to comment on it"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
                {picking ? "Click an element…" : "Comment"}
              </button>
            )}
            {canComment && (
              <button
                type="button"
                onClick={() => setPanelOpen((o) => !o)}
                className="flex items-center gap-1 text-xs text-muted hover:text-moss"
              >
                <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                Comments{openCount > 0 ? ` (${openCount})` : ""}
              </button>
            )}
            <button
              type="button"
              onClick={download}
              className="flex items-center gap-1 text-xs text-muted hover:text-moss"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Download
            </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ArtifactFrame
            title={doc.title}
            rendered={doc.rendered}
            icon={doc.icon || undefined}
            description={doc.description || undefined}
            picking={picking}
            anchors={anchors}
            theme={theme}
            onPick={(pick) => {
              setPendingPick(pick);
              setPicking(false);
            }}
            onRects={(next) => setRects(next)}
            className="absolute inset-0 h-full w-full border-0 bg-transparent"
          />
          {canComment && (
            <ArtifactPins
              threads={threads}
              rects={rects ?? {}}
              onOpenThread={(rootId) => {
                setSelectedThreadId(rootId);
                setPanelOpen(true);
              }}
            />
          )}
          {canComment && (
            <CommentComposer
              pick={
                pendingPick
                  ? { ...pendingPick, rect: rects?.[pendingPick.vdid] ?? pendingPick.rect }
                  : null
              }
              authorName={authorName}
              canSendToSession={commentsQ.data?.canSendToSession === true}
              busy={addComment.isPending}
              onSubmit={submitComment}
              onClose={() => setPendingPick(null)}
            />
          )}
        </div>
        {canComment && panelOpen && (
          <ArtifactThreadPanel
            threads={threads}
            rects={rects}
            selectedThreadId={selectedThreadId}
            canResolve={(thread) =>
              commentsQ.data?.canResolveAll === true || thread.root.authorUserId === meQ.data?.id
            }
            busy={addComment.isPending || resolveComment.isPending}
            onReply={(rootId, body) => addComment.mutate({ body, parentId: rootId })}
            onResolve={(rootId) => resolveComment.mutate({ commentId: rootId })}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
