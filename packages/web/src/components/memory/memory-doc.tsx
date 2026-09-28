import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { qkMemory, useMemoryDoc } from "~/api/memory";
import { useWorkspaceName } from "~/lib/workspace-name";
import { useOrg, useTeams } from "~/api/settings";
import { api, ApiError, type OwnerFilter } from "~/api/client";
import { Badge, Button, Spinner } from "~/components/primitives";
import { Markdown } from "~/components/markdown";
import { MarkdownEditor } from "~/components/markdown-editor";
import { downloadTextFile, memoryDownloadName } from "~/lib/download";
import { splitFrontmatter } from "~/lib/frontmatter";
import { relativeTime } from "~/lib/relative-time";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { MemoryTransfer } from "./memory-transfer";
import { ShareControls } from "./share-controls";

/** Pure — the exact prefill text the footer hands off to the composer. */
export function memoryDocPrefillText(path: string): string {
  return `Update memory file ${path}: `;
}

export interface MemoryDocProps {
  path: string;
  /**
   * The workspace scope the file belongs to. The `/memory` route passes the
   * active workspace (`useListOwner`) so a team file loads from the TEAM's
   * corpus; without it the API defaults to the caller's own memory
   * (TKAI-262: the tree listed team files the doc pane then 404'd on). The
   * chat memory-viewer dialog deliberately omits it — tool renderers read
   * the caller's own scope (artifacts design, Deviations).
   */
  owner?: OwnerFilter;
  /**
   * Called after the prefill store is seeded, to actually leave the page
   * (`navigate({ to: "/chat" })` in production). Kept as a callback rather
   * than calling `useNavigate` in here so this component renders/tests
   * without a `RouterProvider` — same reasoning as `signal-card.tsx`'s
   * `onOpenChild`.
   */
  onNavigateToChat: () => void;
  /** Called after a successful delete (`navigate({ to: "/memory" })` in
   * production) — same router-free convention as `onNavigateToChat`. */
  onDeleted?: () => void;
  /** Called with the target path when the reader follows a cross-reference
   * to another memory file (`navigate({ to: "/memory/$" })` in production)
   * — same router-free convention as `onNavigateToChat`. Without it, a
   * cross-reference falls back to a plain link. */
  onOpenPath?: (path: string) => void;
}

/**
 * Right pane of the memory explorer (Task 6 brief): the notebook-style
 * document view. Title + body render in the display face;
 * frontmatter is never shown raw — `splitFrontmatter` (display-only, tolerant)
 * pulls `type`/`tags`/`sensitivity`/`origin` out as quiet badges and the
 * component renders only the body markdown.
 *
 * Edit swaps the rendered body for a plain-markdown textarea over the
 * STORED content (`file.content`, no frontmatter — the server re-derives
 * the title and keeps type/tags/pinned as they were). Delete is
 * confirm-gated inline, no dialog. Pin toggles `pinned` through the same
 * `PUT /api/memory` write, with no `content` — a metadata-only update.
 * Share opens the artifact controls (`share-controls.tsx`); Download saves
 * the full document, frontmatter included.
 */
export function MemoryDoc(props: MemoryDocProps) {
  // Every consumer gets a new draft and confirmation when the resource changes.
  const { path, owner } = props;
  const resourceKey = JSON.stringify([owner?.ownerType, owner?.ownerId, path]);
  return <ResourceMemoryDoc key={resourceKey} {...props} />;
}

function ResourceMemoryDoc({ path, owner, onNavigateToChat, onDeleted, onOpenPath }: MemoryDocProps) {
  const docQ = useMemoryDoc(path, owner);
  const queryClient = useQueryClient();
  // Label the memory owner, not an assistant identity.
  const name = useWorkspaceName(owner);

  // Team memory: reads follow membership, writes follow authority (team
  // admin or org admin — `authorizeOwner` in routes/memory.ts). Mirror that
  // split here so a plain member doesn't get write buttons the API refuses.
  // Sharing and the composer prefill stay own-scope only: `mem_share`
  // refuses team paths in v1, and "Ask in {name} to update this" writes the
  // caller's own corpus, not the team's.
  const isTeamScope = owner?.ownerType === "team";
  const teamsQ = useTeams({ enabled: isTeamScope });
  const orgQ = useOrg({ enabled: isTeamScope });
  const canWrite =
    !isTeamScope ||
    orgQ.data?.callerRole === "admin" ||
    teamsQ.data?.teams.some((t) => t.id === owner?.ownerId && t.callerRole === "admin") === true;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Invalidations use the OWNERLESS keys on purpose: react-query matches key
  // prefixes, so `doc(path)` / `tree()` cover every owner variant of the same
  // data — this pane's scoped copy AND the ownerless copies the dashboard
  // memory card and the chat memory-viewer dialog hold. Owner-ful keys would
  // match only this pane's copy and leave the others stale.
  const saveMutation = useMutation({
    mutationFn: (content: string) => api.writeMemoryDoc({ path, content }, owner),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: qkMemory.doc(path) });
      await queryClient.invalidateQueries({ queryKey: qkMemory.tree() });
    },
  });

  // Metadata-only write: `PUT /api/memory` leaves the body untouched when
  // `content` is absent, so pinning never rewrites the document.
  const pinMutation = useMutation({
    mutationFn: (pinned: boolean) => api.writeMemoryDoc({ path, pinned }, owner),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qkMemory.doc(path) });
      await queryClient.invalidateQueries({ queryKey: qkMemory.tree() });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteMemoryDoc(path, owner),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qkMemory.tree() });
      queryClient.removeQueries({ queryKey: qkMemory.doc(path) });
    },
  });

  function askToUpdate() {
    useComposerPrefillStore.getState().set(memoryDocPrefillText(path));
    onNavigateToChat();
  }

  if (docQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  const notFound = docQ.error instanceof ApiError && docQ.error.status === 404;
  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center text-sm text-muted">
        <p>Nothing here yet.</p>
        <p>
          Start a thread in {name}, or import a bundle via the API.
        </p>
      </div>
    );
  }

  if (docQ.error) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-danger-500">
        <div>
          Couldn't load this file.
          <div className="mt-2">
            <button type="button" className="underline" onClick={() => docQ.refetch()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!docQ.data || docQ.data.kind !== "file" || !docQ.data.file) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
        This is a directory — pick a file from the tree.
      </div>
    );
  }

  const { file, rendered } = docQ.data;
  const { meta, body } = splitFrontmatter(rendered);
  const type = meta.type ?? file.type;
  const tags = meta.tags ?? [];

  function startEditing() {
    // `file` is narrowed non-null above; TS can't carry that into the
    // closure, so re-read from the query data.
    setDraft(docQ.data?.file?.content ?? "");
    setEditing(true);
    setConfirmingDelete(false);
  }

  return (
    <article className={editing ? "mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10" : "mx-auto max-w-[65ch] px-4 py-6 sm:px-6 sm:py-10"}>
      <header className="mb-8 space-y-3 border-b border-line pb-6">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-4">
          <h1 className="min-w-0 break-words font-display text-2xl sm:text-3xl leading-tight text-ink">
            {file.pinned && <span aria-hidden="true">📌 </span>}
            {file.title || path}
          </h1>
          {!editing && (
            <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 pt-2 text-xs">
              {!isTeamScope && <ShareControls path={path} />}
              <button
                type="button"
                onClick={() => downloadTextFile(memoryDownloadName(path), rendered, "text/markdown")}
                className="max-sm:min-h-11 max-sm:px-2 text-muted hover:text-moss"
              >
                Download
              </button>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => pinMutation.mutate(!file.pinned)}
                  disabled={pinMutation.isPending}
                  aria-pressed={file.pinned}
                  className="max-sm:min-h-11 max-sm:px-2 text-muted hover:text-moss"
                >
                  {file.pinned ? "Unpin" : "Pin"}
                </button>
              )}
              {canWrite && (
                <button type="button" onClick={startEditing} className="max-sm:min-h-11 max-sm:px-2 text-muted hover:text-moss">
                  Edit
                </button>
              )}
              {canWrite && confirmingDelete ? (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    // Per-call callbacks run only while this resource is mounted.
                    onClick={() => deleteMutation.mutate(undefined, { onSuccess: () => onDeleted?.() })}
                    disabled={deleteMutation.isPending}
                    className="max-sm:min-h-11 max-sm:px-2 font-medium text-danger-500 hover:underline"
                  >
                    {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="max-sm:min-h-11 max-sm:px-2 text-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </span>
              ) : canWrite ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="max-sm:min-h-11 max-sm:px-2 text-muted hover:text-danger-500"
                >
                  Delete
                </button>
              ) : null}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{type}</Badge>
          {tags.map((tag) => (
            <Badge key={tag} variant="neutral">
              {tag}
            </Badge>
          ))}
          {meta.sensitivity && <Badge variant="accent">{meta.sensitivity}</Badge>}
          {meta.origin && <Badge variant="neutral">{meta.origin}</Badge>}
        </div>
        <p className="text-xs text-muted">Updated {relativeTime(file.updatedAt)}</p>
        {pinMutation.error instanceof Error && (
          <p className="text-xs text-danger-500">
            Pin failed: {pinMutation.error.message}. Try again, or reload the page.
          </p>
        )}
        {deleteMutation.error instanceof Error && (
          <p className="text-xs text-danger-500">
            Delete failed: {deleteMutation.error.message}. Try again, or reload the page.
          </p>
        )}
      </header>

      {editing ? (
        <div className="space-y-3">
          <MarkdownEditor value={draft} onChange={setDraft} ariaLabel="Memory content" autoFocus />
          {saveMutation.error instanceof Error && (
            <p className="text-xs text-danger-500">
              Save failed: {saveMutation.error.message}. Try again — your draft is still here.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate(draft)}
              disabled={saveMutation.isPending || draft.trim().length === 0}
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            {draft.trim().length === 0 && (
              <span className="text-xs text-muted">Content can't be empty — use Delete instead.</span>
            )}
          </div>
        </div>
      ) : (
        <Markdown
          className="font-display text-[17px] prose-headings:font-display"
          memoryLinks={onOpenPath ? { fromPath: path, onNavigate: onOpenPath } : undefined}
        >
          {body}
        </Markdown>
      )}

      {!editing && (
        <MemoryTransfer key={`${owner?.ownerType}:${owner?.ownerId}:${path}`} path={path} owner={owner} />
      )}

      {!editing && !isTeamScope && (
        <footer className="mt-12 border-t border-line pt-6">
          <button type="button" onClick={askToUpdate} className="min-h-11 text-sm text-moss hover:underline">
            Ask in {name} to update this
          </button>
        </footer>
      )}
    </article>
  );
}
