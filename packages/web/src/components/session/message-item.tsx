import { FileText, Reply } from "lucide-react";
import { memo, useMemo } from "react";
import type {
  MessagePart,
  MessageSkillInvocation,
  PromptImageAttachment,
  PromptFileAttachment,
  MessageReplyReference,
} from "@valet/api/wire";
import type { SettledOutcome, StreamMessage } from "~/stores/stream";
import { Markdown } from "~/components/markdown";
import { CopyButton } from "./tool-renderers/tool-shell";
import { pickRenderer, ToolShell } from "./tool-renderers";
import { showsLiveBody } from "./tool-renderers/types";
import { ToolBody } from "./tool-renderers/tool-shell";
import { Thinking } from "./tool-renderers/thinking";
import { extractSkillInvocation, type SkillBlock } from "./tool-renderers/skill";
import { cn } from "~/lib/cn";
import { shortModelLabel } from "~/lib/models";
import { useRateMessage, useSessionRatings } from "~/api/queries";
import { RatingButtons } from "./rating-buttons";

/**
 * Per-message 👍/👎 (TKAI-334): finer-grained than the session-level rating
 * in the header — "turn 3 was bad" data, not the primary eval signal.
 * Hidden until hover unless a rating is set (mirrors the copy button).
 */
function MessageRating({ message }: { message: StreamMessage }) {
  const ratings = useSessionRatings(message.sessionId);
  const rate = useRateMessage(message.sessionId);
  const value = ratings.data?.entries[message.id] ?? null;
  return (
    <RatingButtons
      subject="reply"
      value={value}
      disabled={rate.isPending}
      onRate={(rating) =>
        rate.mutate({ entryId: message.id, threadId: message.threadId ?? undefined, rating })
      }
      className={cn(
        "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity",
        value !== null && "opacity-100",
      )}
    />
  );
}

/**
 * `text_delta` replaces only the active message object, but MessageList must
 * still render to follow the stream. Memoizing at this stable prop boundary
 * keeps every unchanged history row from rebuilding its Markdown tree.
 */
export const MessageItem = memo(function MessageItem({
  message,
  suppressEmptyPlaceholder = false,
  viewerId,
  onReply,
}: {
  message: StreamMessage;
  /** True for the last message while the agent is mid-turn — an empty
   *  assistant row is then a streaming placeholder, not a failed turn. */
  suppressEmptyPlaceholder?: boolean;
  /** The signed-in user's id — see `MessageList`'s prop doc. */
  viewerId?: string;
  /** Selects a completed assistant text message as the composer reply target. */
  onReply?: (target: MessageReplyReference) => void;
}) {
  const isUser = message.role === "user";
  const copyText = messageCopyText(message);
  // Defined only for another member's message on a shared session; the
  // viewer's own messages (and authorless rows) keep the "You" treatment.
  const teammate = isUser ? senderLabel(message.author, viewerId) : undefined;
  return (
    <article data-message-id={message.id} className="group min-w-0 px-5 py-3 sm:px-8">
      {/* Row background spans full width; the content column is capped at a
          readable measure and centered — prose and tool cards both benefit. */}
      <div className={cn(
        "mx-auto flex w-full min-w-0 max-w-3xl justify-end"
      )}>

        <div className={cn("flex-1 min-w-0 space-y-2", isUser && "sm:max-w-[85%] rounded-2xl bg-ink-wash px-4 py-3")}>
          <div className="text-xs text-muted flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-medium text-[--fg]/80">
              {isUser ? teammate ?? "You" : message.role === "assistant" ? "Assistant" : message.role}
            </span>
            <span>•</span>
            <span>{formatTime(message.createdAt)}</span>
            {message.role === "assistant" && message.model && (
              <span
                className="hidden sm:inline font-mono text-[10px] text-muted opacity-80"
                title={message.model}
              >
                {shortModelLabel(message.model)}
              </span>
            )}
            {message.settledOutcome && <SettledBadge outcome={message.settledOutcome} />}
            <div className="ml-auto flex items-center gap-1">
              {message.role === "assistant" && message.completed === true && copyText && onReply && (
                <button
                  type="button"
                  onClick={() => onReply({ messageId: message.id, excerpt: replyExcerpt(copyText) })}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus:opacity-100"
                  aria-label="Reply to message"
                >
                  <Reply className="h-3 w-3" aria-hidden />
                  Reply
                </button>
              )}
              {message.role === "assistant" && <MessageRating message={message} />}
              {copyText && (
                <CopyButton
                  getText={() => copyText}
                  label="Copy message"
                  className="opacity-0 group-hover:opacity-100"
                />
              )}
            </div>
          </div>
          <div className="space-y-2">
            {isUser && message.replyTo && (
              <blockquote className="rounded border-l-2 border-moss bg-moss-wash px-3 py-2 text-xs text-muted">
                <span className="font-medium text-ink">Replying to Assistant</span>
                <p className="mt-1 line-clamp-3">{message.replyTo.excerpt}</p>
              </blockquote>
            )}
            {isUser && message.attachments && message.attachments.length > 0 && (
              <UserAttachmentStrip attachments={message.attachments} />
            )}
            {message.parts.length === 0 && message.content && (
              <TextBlock text={message.content} skillMeta={isUser ? message.skill : undefined} detectSkill={isUser} />
            )}
            {message.parts.map((part, i) => (
              // Tool cards hold per-mount UI state (expansion, user-touch
              // override), so key them by their stable callId: an index key
              // hands one call's state to a different call whenever the
              // parts array shifts (streaming sweep, message_update
              // replacement). Text/thinking parts are stateless and
              // positional, so the index is fine for them.
              <PartView
                key={part.kind === "tool_call" ? `tc-${part.callId}` : `${part.kind}-${i}`}
                part={part}
                skillMeta={isUser ? message.skill : undefined}
                detectSkill={isUser}
              />
            ))}
            {!suppressEmptyPlaceholder && isEmptyAssistantMessage(message) && (
              <p className="text-xs italic text-muted">
                (no response — the turn failed or was interrupted before any
                output; see the error above or the server logs)
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  );
});

/**
 * A persisted assistant row with no parts and no content is what a turn
 * that died before its first token leaves behind (e.g. the provider
 * rejected the call — bad key, exhausted credits). Rendering it as a blank
 * bubble made those failures look like the product silently broke; name
 * the state instead. Exported for tests.
 */
export function isEmptyAssistantMessage(message: StreamMessage): boolean {
  return (
    message.role === "assistant" &&
    message.parts.length === 0 &&
    !message.content &&
    !message.signal
  );
}

/**
 * The clipboard payload for a message's copy button: the visible prose —
 * text parts joined by blank lines, or the legacy `content` field when a
 * message has no parts. Thinking and tool-call parts stay out; the debug
 * transcript (session header) covers those. Empty string means no button.
 * Exported for tests.
 */
export function replyExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const codepoints = Array.from(normalized);
  return codepoints.length <= 280
    ? normalized
    : codepoints.slice(0, 279).join("").trimEnd() + "…";
}

export function messageCopyText(message: StreamMessage): string {
  const texts = message.parts
    .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text.trim())
    .filter(Boolean);
  const raw = texts.length > 0 ? texts.join("\n\n") : (message.content?.trim() ?? "");
  // A skill-invocation user message displays as a card plus the typed
  // arguments — copying the raw multi-KB expansion would paste internal
  // markup that, re-sent, bypasses dispatch and persists the stale skill
  // body. Copy the re-sendable command form instead.
  if (message.role === "user" && raw) {
    const block = extractSkillInvocation(raw, message.skill);
    if (block) return `/skill:${block.name}${block.rest ? ` ${block.rest}` : ""}`;
  }
  return raw;
}

/**
 * The display label for a user message sent by someone OTHER than the
 * viewer — a teammate on a shared (team-owned) session. Returns undefined
 * for the viewer's own messages and for authorless rows (personal
 * sessions, optimistic rows, entries from before authors were stamped);
 * the caller renders those as "You". `||` (not `??`) so an empty-string
 * name still falls through to email. Exported for tests.
 */
export function senderLabel(
  author: StreamMessage["author"],
  viewerId: string | undefined,
): string | undefined {
  if (!author || author.id === viewerId) return undefined;
  return author.name || author.email || "Teammate";
}

function PartView({
  part,
  skillMeta,
  detectSkill,
}: {
  part: MessagePart;
  skillMeta?: MessageSkillInvocation;
  detectSkill?: boolean;
}) {
  switch (part.kind) {
    case "text":
      return <TextBlock text={part.text} skillMeta={skillMeta} detectSkill={detectSkill} />;
    case "thinking":
      return <Thinking text={part.text} />;
    case "tool_call":
      return <ToolCallBlock part={part} />;
  }
}

function TextBlock({
  text,
  skillMeta,
  detectSkill = false,
}: {
  text: string;
  /** Wire skill stamp from the enclosing message (user messages only). */
  skillMeta?: MessageSkillInvocation;
  /** True only for user messages — the dispatcher writes skill blocks
   *  nowhere else, and assistant prose that quotes one must stay prose. */
  detectSkill?: boolean;
}) {
  // Memoized so streaming re-renders elsewhere in the thread don't re-run
  // the extraction on static user text every frame.
  const block = useMemo(
    () => (detectSkill ? extractSkillInvocation(text, skillMeta) : null),
    [text, skillMeta, detectSkill],
  );
  if (!text) return null;
  if (block) {
    return (
      <>
        <SkillInvocationBlock block={block} />
        {block.rest && <Markdown>{block.rest}</Markdown>}
      </>
    );
  }
  return <Markdown>{text}</Markdown>;
}

/**
 * The transcript card for a skill-invocation user message. Synthesizes a
 * settled `tool_call` part and renders it through the SAME ToolCallBlock
 * as the model's own `skill` tool call, so the two paths cannot drift.
 * Trailing user arguments are the caller's to render — they are the
 * user's actual prompt, not part of the skill.
 */
export const SkillInvocationBlock = memo(function SkillInvocationBlock({
  block,
}: {
  block: SkillBlock;
}) {
  const part = useMemo<Extract<MessagePart, { kind: "tool_call" }>>(
    () => ({
      kind: "tool_call",
      callId: "skill-invocation",
      toolName: "skill",
      status: "completed",
      args: { name: block.name },
      result: { text: block.content },
    }),
    [block],
  );
  return <ToolCallBlock part={part} />;
});

/**
 * Read-only strip for a user message's attachments (images and files).
 * Images render as thumbnails; files as compact badges with icons.
 * Sent messages are immutable — no remove control.
 */
function UserAttachmentStrip({
  attachments,
}: {
  attachments: Array<PromptImageAttachment | PromptFileAttachment>;
}) {
  const images = attachments.filter((a): a is PromptImageAttachment => a.kind === "image");
  const files = attachments.filter((a): a is PromptFileAttachment => a.kind === "file");

  return (
    <div className="mb-1.5 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Attached images">
          {images.map((a, i) => (
            <img
              key={`img-${i}`}
              src={a.url}
              alt={a.name}
              className="max-h-40 rounded-lg border border-[--border]"
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Attached files">
          {files.map((f, i) => (
            <div
              key={`file-${i}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[--border] bg-[--bg-secondary]"
              title={f.path}
            >
              <FileText className="h-4 w-4 text-muted" />
              <span className="truncate">{f.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ part }: { part: Extract<MessagePart, { kind: "tool_call" }> }) {
  const renderer = pickRenderer(part.toolName, part.args);
  // A held renderer (streaming, no streamsArgs opt-in) gets a bare header:
  // formatTarget/formatSummary would compute from partial, jagged args
  // (truncated paths, churning line counts) the renderer never opted to see.
  const live = showsLiveBody(renderer, part.status);
  const target = live ? renderer.formatTarget(part.args, part.toolName) : undefined;
  const summary = live
    ? renderer.formatSummary?.(part.args, part.result, part.status, part.toolName)
    : undefined;
  const Body = renderer.Body;

  return (
    <ToolShell
      toolName={part.toolName}
      category={renderer.category}
      Icon={renderer.Icon}
      target={target}
      summary={summary}
      status={part.status}
    >
      {live ? (
        <Body
          args={part.args}
          result={part.result}
          status={part.status}
          error={part.error}
          toolName={part.toolName}
        />
      ) : (
        // Args are still streaming and this renderer didn't opt in — hold
        // the body until the call is complete, like before streaming existed.
        <ToolBody className="text-[11px] text-muted italic font-mono">
          receiving arguments…
        </ToolBody>
      )}
    </ToolShell>
  );
}

/**
 * Terminal-outcome badge for a queued submission, per Task 7 design point 4:
 * superseded/merged read as muted (the turn was cleanly folded away by a
 * later prompt); failed/aborted read as a subtle failure signal.
 */
function SettledBadge({ outcome }: { outcome: SettledOutcome }) {
  const isFailure = outcome === "failed" || outcome === "aborted";
  const label =
    outcome === "superseded"
      ? "superseded"
      : outcome === "merged"
        ? "merged into next"
        : outcome;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium",
        isFailure
          ? "bg-danger-500/10 text-danger-600 dark:text-danger-400"
          : "bg-neutral-200/70 text-muted dark:bg-neutral-800/70",
      )}
    >
      {label}
    </span>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
