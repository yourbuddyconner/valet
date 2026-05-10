import { MessagesSquare } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/cn";
import { ToolBody } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

interface ThreadReadArgs {
  key?: unknown;
  limit?: unknown;
}

function getKey(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const k = (args as ThreadReadArgs).key;
  return typeof k === "string" ? k : "";
}

interface ParsedMessage {
  role: string;
  meta: string;
  content: string;
}

/**
 * The engine's threadRead builtin emits a markdown-ish format:
 *   # thread:web:default
 *   ## user (Alice) @ 2026-05-09T19:00:00.000Z
 *   the body…
 *   ## assistant @ ...
 *   …
 * Parse it back into a structured message list so we can render bubbles.
 * If parsing fails (plugin returns a totally different shape), fall back
 * to the raw text in a code block.
 */
function parseThreadDump(text: string): ParsedMessage[] | null {
  if (!text.startsWith("# thread:")) return null;
  // Remove the "# thread:..." header.
  const firstHeader = text.indexOf("\n## ");
  if (firstHeader < 0) return [];
  const rest = text.slice(firstHeader + 1);
  const chunks = rest.split(/\n## /);
  const messages: ParsedMessage[] = [];
  for (const chunk of chunks) {
    const c = chunk.startsWith("## ") ? chunk.slice(3) : chunk;
    const nl = c.indexOf("\n");
    const head = nl >= 0 ? c.slice(0, nl) : c;
    const content = nl >= 0 ? c.slice(nl + 1).trim() : "";
    // head looks like: "user (Alice) @ 2026-05-09T..."
    const at = head.indexOf(" @ ");
    const left = at >= 0 ? head.slice(0, at).trim() : head.trim();
    const ts = at >= 0 ? head.slice(at + 3).trim() : "";
    // Split role from "(Alice)" suffix.
    const paren = left.indexOf(" (");
    const role = paren >= 0 ? left.slice(0, paren).trim() : left;
    const author = paren >= 0 ? left.slice(paren).trim() : "";
    const meta = [author, ts && relativeTime(ts)].filter(Boolean).join(" · ");
    messages.push({ role, meta, content });
  }
  return messages;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

const ROLE_TONE: Record<string, string> = {
  user: "border-l-sky-500/50 dark:border-l-sky-400/50",
  assistant: "border-l-violet-500/50 dark:border-l-violet-400/50",
  tool: "border-l-amber-500/50 dark:border-l-amber-400/50",
  system: "border-l-neutral-400/50 dark:border-l-neutral-600/50",
};

const ROLE_LABEL_TONE: Record<string, string> = {
  user: "text-sky-700 dark:text-sky-400",
  assistant: "text-violet-700 dark:text-violet-400",
  tool: "text-amber-700 dark:text-amber-400",
  system: "text-neutral-600 dark:text-neutral-400",
};

export const threadReadRenderer: ToolRenderer = {
  matches: "thread_read",
  category: "thread",
  Icon: MessagesSquare,
  formatTarget: (args) => getKey(args) || undefined,
  formatSummary: (_args, result, status) => {
    if (status === "running") return undefined;
    const parsed = parseThreadDump(resultText(result));
    if (!parsed) return undefined;
    const n = parsed.length;
    return `${n} ${n === 1 ? "message" : "messages"}`;
  },
  Body: ({ args, result, status, error }) => {
    const key = getKey(args);
    const text = error ?? resultText(result);
    const parsed = parseThreadDump(text);

    return (
      <ToolBody className="px-0 py-0">
        {key && (
          <div className="px-3 py-1.5 border-b border-[--border]/60 bg-neutral-50 dark:bg-neutral-900/60 text-[11px] flex items-center gap-2">
            <span className="text-[--muted]">reading from</span>
            <span className="font-mono text-[--fg]/95">{key}</span>
          </div>
        )}
        {status === "running" ? (
          <div className="px-3 py-2 text-[11px] text-[--muted] italic font-mono">scanning thread…</div>
        ) : parsed && parsed.length > 0 ? (
          <ThreadExcerpts messages={parsed} />
        ) : parsed && parsed.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-[--muted] italic">
            (thread is empty)
          </div>
        ) : (
          <pre className="px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-[--fg]/85">
            {text}
          </pre>
        )}
      </ToolBody>
    );
  },
};

function ThreadExcerpts({ messages }: { messages: ParsedMessage[] }) {
  const [showAll, setShowAll] = useState(false);
  const MAX = 4;
  const visible = showAll ? messages : messages.slice(-MAX);
  const hidden = messages.length - visible.length;

  return (
    <div className="px-2 py-1.5">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="block w-full text-center mb-2 text-[11px] text-[--muted] hover:text-[--fg] py-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-900/60"
        >
          ↑ show {hidden} earlier {hidden === 1 ? "message" : "messages"}
        </button>
      )}
      <ul className="space-y-2">
        {visible.map((m, i) => (
          <li
            key={i}
            className={cn(
              "border-l-2 pl-2.5 py-0.5",
              ROLE_TONE[m.role] ?? ROLE_TONE.system,
            )}
          >
            <div className="flex items-baseline gap-1.5 mb-0.5">
              <span
                className={cn(
                  "text-[10px] uppercase tracking-wider font-semibold",
                  ROLE_LABEL_TONE[m.role] ?? ROLE_LABEL_TONE.system,
                )}
              >
                {m.role}
              </span>
              {m.meta && (
                <span className="text-[10px] text-[--muted]/80">{m.meta}</span>
              )}
            </div>
            <div className="text-[12px] text-[--fg]/90 leading-snug whitespace-pre-wrap line-clamp-4">
              {m.content || (
                <span className="italic text-[--muted]">(empty)</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
