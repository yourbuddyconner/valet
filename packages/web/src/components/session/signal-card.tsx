import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Message, MessageSignal } from "@valet/api/wire";
import { Badge } from "~/components/primitives";
import { Markdown } from "~/components/markdown";

const BODY_PREVIEW_LEN = 200;

/** Pure: first ~`max` chars of `text`, with an ellipsis when truncated. */
export function truncateBody(text: string, max = BODY_PREVIEW_LEN): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/** Pure: child card title — `attributes.title`, falling back to the child id. */
export function childCardTitle(signal: MessageSignal): string {
  return signal.attributes?.title || signal.senderSessionId || "child runtime";
}

/**
 * Signal cards (assistant-centered web UI, decision 3): a wire message
 * carrying `signal` renders as a card, never a user bubble.
 * `signalType === "child.settled"` gets a dedicated child card; everything
 * else gets a generic labeled envelope. Both carry the moss left rail —
 * "events from the world look categorically different from typed
 * messages."
 *
 * `message.signal` must be set — callers (MessageList) are responsible for
 * only routing signal-bearing messages here.
 */
export function SignalCard({
  message,
  onOpenChild,
}: {
  message: Message;
  onOpenChild?: (childSessionId: string) => void;
}) {
  const signal = message.signal;
  if (!signal) return null;

  if (signal.signalType === "child.settled") {
    return <ChildSettledCard message={message} signal={signal} onOpenChild={onOpenChild} />;
  }
  return <EnvelopeCard message={message} signal={signal} />;
}

function CardShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-4 my-3 rounded-md border border-line border-l-2 border-l-moss bg-paper px-4 py-3">
      {children}
    </div>
  );
}

function ChildSettledCard({
  message,
  signal,
  onOpenChild,
}: {
  message: Message;
  signal: MessageSignal;
  onOpenChild?: (childSessionId: string) => void;
}) {
  const title = childCardTitle(signal);
  const outcome = signal.attributes?.outcome;
  const preview = truncateBody(message.content);
  const childId = signal.senderSessionId;

  const body = (
    <CardShell>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink truncate">{title}</span>
        {outcome && <OutcomeBadge outcome={outcome} />}
      </div>
      {preview && <p className="mt-1.5 text-sm text-muted whitespace-pre-wrap">{preview}</p>}
    </CardShell>
  );

  if (!childId) return body;

  if (onOpenChild) {
    return (
      <button
        type="button"
        onClick={() => onOpenChild(childId)}
        className="block w-full text-left hover:bg-ink-wash rounded-md transition-colors"
      >
        {body}
      </button>
    );
  }

  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: childId }}
      className="block hover:bg-ink-wash rounded-md transition-colors"
    >
      {body}
    </Link>
  );
}

/**
 * A workflow run's report, with a link back to the run.
 *
 * The generic envelope labelled this "workflow.request" and stopped there,
 * so a person reading their assistant could see that a workflow had said
 * something but not which one, nor open it. `promptOrchestrator` now sets
 * `attributes.runId` (`api/src/workflows/engine-deps.ts`); a signal that
 * predates that still renders through the envelope below.
 */
function WorkflowRequestCard({ message, runId }: { message: Message; runId: string }) {
  return (
    <CardShell>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center rounded-sm bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          workflow
        </span>
        <Link
          to="/workflows/runs/$runId"
          params={{ runId }}
          className="text-[11px] text-muted hover:underline"
        >
          Open run
        </Link>
      </div>
      {message.content && (
        <div className="mt-1.5 text-sm text-ink">
          <Markdown>{message.content}</Markdown>
        </div>
      )}
    </CardShell>
  );
}

function EnvelopeCard({ message, signal }: { message: Message; signal: MessageSignal }) {
  const runId = signal.signalType === "workflow.request" ? signal.attributes?.runId : undefined;
  if (runId) return <WorkflowRequestCard message={message} runId={runId} />;
  return (
    <CardShell>
      <span className="inline-flex items-center rounded-sm bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
        {signal.signalType}
      </span>
      {message.content && (
        <div className="mt-1.5 text-sm text-ink">
          <Markdown>{message.content}</Markdown>
        </div>
      )}
    </CardShell>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const isFailure = outcome === "failed" || outcome === "aborted";
  return <Badge variant={isFailure ? "danger" : "success"}>{outcome}</Badge>;
}
