/**
 * Debug transcript builder. Produces a self-contained markdown blob for
 * pasting into bug reports: header (IDs + environment), timeline of
 * messages with raw tool-call args/results, and a machine-readable JSON
 * appendix so a reader can replay the exact state the UI saw.
 *
 * Kept pure (no React, no clipboard) so it's unit-testable and reusable —
 * the button component wraps `buildTranscript` + a clipboard write.
 */
import type { Message, SessionDetail } from "@valet/api/wire";
import { formatBytes } from "~/lib/format-bytes";
import type { AgentStatus, ConnectionStatus } from "~/stores/stream";

export interface TranscriptContext {
  session: SessionDetail;
  threadId: string | undefined;
  messages: Message[];
  agentStatus: AgentStatus;
  conn: ConnectionStatus;
  sandbox?: { state: string; epoch: number };
  user?: { id: string; email?: string | null; name?: string | null };
  org?: { id: string; name?: string | null };
  /** ISO timestamp for the header — `now` at build time. */
  now?: string;
  /** Environment surface — origin URL, build info if the caller has it. */
  env?: {
    origin?: string;
    userAgent?: string;
  };
}

const HEADER_RULE = "─".repeat(60);

/** Truncate values that would blow up the transcript (very large tool results). */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function safeJson(value: unknown, indent = 2): string {
  try {
    // JSON.stringify(undefined) returns undefined (not a string) — a
    // streaming tool_call can have no args yet.
    return JSON.stringify(value, null, indent) ?? "undefined";
  } catch (err) {
    return `<unserializable: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

/**
 * Shallow-copy a message with any attachment `url` fields truncated to the
 * first 80 chars. A single `data:image/png;base64,…` URL can be a megabyte;
 * dumping the raw payload turns the appendix into noise for debug-paste
 * use. `truncate` is a per-value guard on the whole `safeJson` output — it
 * clips the whole doc, not per-url — so shorten here.
 */
function shortenAttachmentUrls(m: Message): Message {
  if (!m.attachments || m.attachments.length === 0) return m;
  const short = m.attachments.map((a) => {
    // File attachments carry a sandbox path, not a url — nothing to shorten.
    if (a.kind !== "image" || a.url.length <= 80) return a;
    return { ...a, url: `${a.url.slice(0, 80)}… [${a.url.length} chars]` };
  });
  return { ...m, attachments: short };
}

function renderMessage(m: Message, index: number): string {
  const lines: string[] = [];
  lines.push(`### [${index}] ${m.role} · ${formatTimestamp(m.createdAt)} · id=${m.id}`);
  if (m.threadId) lines.push(`thread: ${m.threadId}`);
  if (m.queueItemId) lines.push(`queueItemId: ${m.queueItemId}`);
  lines.push("");
  if (m.content && m.content.trim().length > 0) {
    lines.push(truncate(m.content, 8000));
    lines.push("");
  }
  if (m.attachments && m.attachments.length > 0) {
    // Name each attachment and report its `data:` URL size — do NOT dump
    // the base64 payload into the timeline (it blows the debug blob up by
    // megabytes per image). The Raw JSON appendix shortens `url` fields
    // via the same guard.
    lines.push("**attachments**");
    for (const a of m.attachments) {
      if (a.kind === "file") {
        lines.push(`- ${a.name} (${a.mimeType ?? "file"}, ${formatBytes(a.bytes)} at ${a.path})`);
        continue;
      }
      const kind = a.url.startsWith("data:") ? "data:URL" : "url";
      lines.push(`- ${a.name} (${a.mimeType}, ${kind} ${formatBytes(a.url.length)})`);
    }
    lines.push("");
  }
  for (const part of m.parts ?? []) {
    if (part.kind === "text") {
      const text = part.text?.trim();
      if (text) {
        lines.push(truncate(text, 8000));
        lines.push("");
      }
    } else if (part.kind === "tool_call") {
      lines.push(`#### tool_call · ${part.toolName} · ${part.status} · callId=${part.callId}`);
      lines.push("");
      lines.push("**args**");
      lines.push("```json");
      lines.push(truncate(safeJson(part.args), 8000));
      lines.push("```");
      if (part.status !== "running" && part.status !== "streaming") {
        lines.push("**result**");
        lines.push("```json");
        lines.push(truncate(safeJson(part.result), 8000));
        lines.push("```");
      }
      if (part.error) {
        lines.push("**error**");
        lines.push("```");
        lines.push(truncate(part.error, 4000));
        lines.push("```");
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function buildTranscript(ctx: TranscriptContext): string {
  const {
    session,
    threadId,
    messages,
    agentStatus,
    conn,
    sandbox,
    user,
    org,
    now = new Date().toISOString(),
    env,
  } = ctx;

  const inThread = threadId
    ? messages.filter((m) => m.threadId === threadId)
    : messages;

  const header: string[] = [
    `# Valet thread transcript`,
    ``,
    `Generated: ${now}`,
    ``,
    HEADER_RULE,
    `session.id:      ${session.id}`,
    `session.title:   ${session.title ?? "(untitled)"}`,
    `session.workspace: ${session.workspace ?? "(none)"}`,
    `session.model:   ${session.model ?? "(runtime default)"}`,
    `thread.id:       ${threadId ?? "(no active thread)"}`,
    `messages:        ${inThread.length}${threadId ? ` (of ${messages.length} loaded across threads)` : ""}`,
    ``,
    `agent.status:    ${agentStatus}`,
    `ws.conn:         ${conn}`,
    `sandbox.state:   ${sandbox ? `${sandbox.state} (epoch ${sandbox.epoch})` : "(unknown)"}`,
    ``,
    `user.id:         ${user?.id ?? "(unknown)"}`,
    `user.email:      ${user?.email ?? "(unknown)"}`,
    `org.id:          ${org?.id ?? "(unknown)"}`,
    `org.name:        ${org?.name ?? "(unknown)"}`,
    ``,
    `env.origin:      ${env?.origin ?? "(unknown)"}`,
    `env.userAgent:   ${env?.userAgent ?? "(unknown)"}`,
    HEADER_RULE,
    ``,
    `## Timeline`,
    ``,
  ];

  const body = inThread.map((m, i) => renderMessage(m, i)).join("\n---\n\n");

  const appendix: string[] = [
    ``,
    HEADER_RULE,
    `## Raw JSON appendix`,
    ``,
    `Machine-readable snapshot of the same messages the UI rendered — includes`,
    `every tool-call arg/result verbatim (bounded to the same per-value truncation`,
    `as the timeline above). Paste this into a debugger to replay state.`,
    ``,
    "```json",
    truncate(safeJson(inThread.map(shortenAttachmentUrls)), 64_000),
    "```",
  ];

  return [...header, body, ...appendix].join("\n");
}
