/**
 * The comment layer for a published artifact page (artifact-pages design).
 *
 * Everything here renders in APP chrome, outside the sandboxed frame: the
 * untrusted page never hosts a text input and never sees comment text. The
 * frame only contributes element picks and anchor rects over the
 * `ArtifactFrame` bridge; pins and the popover are positioned from those
 * rects inside a parent-owned overlay.
 */
import { useState } from "react";
import { MessageSquare, Send, X } from "lucide-react";
import type { ArtifactCommentWire } from "@valet/api/wire";
import type { ArtifactAnchorRect } from "@valet/shared";
import { Button, Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import type { ArtifactPick } from "./artifact-frame";

export interface ThreadView {
  root: ArtifactCommentWire;
  replies: ArtifactCommentWire[];
}

/** Roots in creation order, each with its replies. Replies whose root is
 * missing (deleted account edge cases) are dropped rather than rendered
 * unparented. */
export function groupThreads(comments: ArtifactCommentWire[]): ThreadView[] {
  const roots = comments.filter((c) => c.parentId === null);
  const byParent = new Map<string, ArtifactCommentWire[]>();
  for (const c of comments) {
    if (c.parentId === null) continue;
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }
  return roots.map((root) => ({ root, replies: byParent.get(root.id) ?? [] }));
}

// ─── Pins ────────────────────────────────────────────────────────────────

interface ArtifactPinsProps {
  threads: ThreadView[];
  rects: Record<string, ArtifactAnchorRect>;
  onOpenThread: (rootId: string) => void;
}

/** Numbered pins at each unresolved anchored thread's element. Rendered in
 * an absolutely-positioned overlay that exactly covers the frame, so frame
 * rects map 1:1 to overlay coordinates. */
export function ArtifactPins({ threads, rects, onOpenThread }: ArtifactPinsProps) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden={threads.length === 0}>
      {threads.map((thread) => {
        if (!thread.root.vdid || thread.root.resolvedAt !== null) return null;
        const rect = rects[thread.root.vdid];
        if (!rect) return null;
        return (
          <button
            key={thread.root.id}
            type="button"
            onClick={() => onOpenThread(thread.root.id)}
            className="pointer-events-auto absolute z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-paper text-[11px] font-medium text-ink shadow-md hover:bg-moss hover:text-white"
            style={{ top: Math.max(rect.top, 4), left: Math.min(rect.left + rect.width + 4, window.innerWidth - 40) }}
            title={thread.root.body}
          >
            {1 + thread.replies.length}
          </button>
        );
      })}
    </div>
  );
}

// ─── Composer popover ────────────────────────────────────────────────────

interface CommentComposerProps {
  pick: ArtifactPick | null;
  authorName: string;
  canSendToSession: boolean;
  busy: boolean;
  onSubmit: (opts: { body: string; sendToSession: boolean }) => void;
  onClose: () => void;
}

/** The element-anchored composer, pinned near the picked element (page-level
 * when `pick` is null-anchored). Mirrors the source product's popover: a
 * textarea, "Send to Claude", "Add comment", and an honest delivery hint. */
export function CommentComposer({
  pick,
  authorName,
  canSendToSession,
  busy,
  onSubmit,
  onClose,
}: CommentComposerProps) {
  const [body, setBody] = useState("");
  if (!pick) return null;

  // Clamp inside the viewport: the pick rect is frame-relative and the
  // overlay covers the frame, so only vertical overflow needs care.
  const top = Math.min(Math.max(pick.rect.top + pick.rect.height + 8, 8), window.innerHeight - 240);
  const left = Math.min(Math.max(pick.rect.left, 8), Math.max(window.innerWidth - 360, 8));

  const submit = (sendToSession: boolean) => {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    onSubmit({ body: trimmed, sendToSession });
    setBody("");
  };

  return (
    <div
      className="absolute z-20 w-[340px] rounded-lg border border-line bg-paper p-3 shadow-xl"
      style={{ top, left }}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="font-medium text-ink">{authorName}</span>
          {pick.label && <span className="truncate">on “{pick.label}”</span>}
        </div>
        <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Shift+Enter submits (mod+Enter sends to the agent when offered);
          // plain Enter keeps inserting newlines — comments are often
          // multi-line.
          if (e.key !== "Enter") return;
          if ((e.metaKey || e.ctrlKey) && canSendToSession) {
            e.preventDefault();
            submit(true);
          } else if (e.shiftKey) {
            e.preventDefault();
            submit(false);
          }
        }}
        placeholder="Add a comment… (Shift+Enter to submit)"
        rows={3}
        autoFocus
        className="w-full resize-none rounded-md border border-line bg-transparent p-2 text-sm text-ink outline-none focus:border-moss"
      />
      <div className="mt-2 flex items-center gap-2">
        {canSendToSession && (
          <Button size="sm" onClick={() => submit(true)} disabled={busy || !body.trim()}>
            {busy ? <Spinner /> : <Send className="h-3.5 w-3.5" />}
            Send to agent
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => submit(false)} disabled={busy || !body.trim()}>
          Add comment
        </Button>
      </div>
      {canSendToSession && (
        <p className="mt-2 text-[11px] leading-snug text-muted">
          “Send to agent” also delivers this comment to the agent that published the page.
        </p>
      )}
    </div>
  );
}

// ─── Thread panel ────────────────────────────────────────────────────────

interface ThreadPanelProps {
  threads: ThreadView[];
  /** Anchor rect availability: used to flag threads whose element is no
   * longer on the page. Null until the frame reports rects at least once —
   * unknown is not orphaned. */
  rects: Record<string, ArtifactAnchorRect> | null;
  selectedThreadId: string | null;
  canResolve: (thread: ThreadView) => boolean;
  busy: boolean;
  onReply: (rootId: string, body: string) => void;
  onResolve: (rootId: string) => void;
  onClose: () => void;
}

export function ArtifactThreadPanel({
  threads,
  rects,
  selectedThreadId,
  canResolve,
  busy,
  onReply,
  onResolve,
  onClose,
}: ThreadPanelProps) {
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");

  const submitReply = (rootId: string) => {
    const trimmed = replyBody.trim();
    if (!trimmed || busy) return;
    onReply(rootId, trimmed);
    setReplyBody("");
    setReplyFor(null);
  };

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-paper">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
          <MessageSquare className="h-4 w-4" aria-hidden />
          Comments
        </h2>
        <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label="Close comments">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {threads.length === 0 && (
          <p className="px-1 py-4 text-sm text-muted">
            No comments yet. Use “Comment” above, then click an element on the page.
          </p>
        )}
        {threads.map((thread) => {
          const orphaned =
            thread.root.vdid !== null && rects !== null && rects[thread.root.vdid] === undefined;
          const resolved = thread.root.resolvedAt !== null;
          const selected = thread.root.id === selectedThreadId;
          return (
            <div
              key={thread.root.id}
              className={`rounded-lg border p-3 ${selected ? "border-moss" : "border-line"} ${resolved ? "opacity-60" : ""}`}
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted">
                <span className="truncate">
                  <span className="font-medium text-ink">{thread.root.authorName}</span>
                  {" · "}
                  {relativeTime(thread.root.createdAt)}
                </span>
                <span className="shrink-0">
                  {thread.root.vdid === null ? "page" : orphaned ? "element removed" : "element"}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-ink">{thread.root.body}</p>
              {thread.root.sentToSession && (
                <p className="mt-1 text-[11px] text-muted">Sent to the publishing agent.</p>
              )}
              {thread.replies.map((reply) => (
                <div key={reply.id} className="mt-2 border-l-2 border-line pl-2">
                  <p className="text-xs text-muted">
                    <span className="font-medium text-ink">{reply.authorName}</span>
                    {" · "}
                    {relativeTime(reply.createdAt)}
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-ink">{reply.body}</p>
                </div>
              ))}
              {!resolved && (
                <div className="mt-2 flex items-center gap-3 text-xs">
                  <button
                    type="button"
                    className="text-moss hover:underline"
                    onClick={() => {
                      setReplyFor(replyFor === thread.root.id ? null : thread.root.id);
                      setReplyBody("");
                    }}
                  >
                    Reply
                  </button>
                  {canResolve(thread) && (
                    <button
                      type="button"
                      className="text-muted hover:text-ink hover:underline"
                      onClick={() => onResolve(thread.root.id)}
                      disabled={busy}
                    >
                      Resolve
                    </button>
                  )}
                </div>
              )}
              {resolved && <p className="mt-2 text-[11px] text-muted">Resolved.</p>}
              {replyFor === thread.root.id && (
                <div className="mt-2">
                  <textarea
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.shiftKey) {
                        e.preventDefault();
                        submitReply(thread.root.id);
                      }
                    }}
                    rows={2}
                    autoFocus
                    placeholder="Reply… (Shift+Enter to submit)"
                    className="w-full resize-none rounded-md border border-line bg-transparent p-2 text-sm text-ink outline-none focus:border-moss"
                  />
                  <div className="mt-1 flex justify-end">
                    <Button size="sm" onClick={() => submitReply(thread.root.id)} disabled={busy || !replyBody.trim()}>
                      Reply
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
