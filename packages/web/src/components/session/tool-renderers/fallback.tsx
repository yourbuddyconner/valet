import { Hexagon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/cn";
import { ToolBody } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

/**
 * Generic renderer used when no built-in matches the tool name. Designed
 * to make plugin tools look polished out of the box without anyone having
 * to write a custom renderer:
 *
 * - Header target: auto-extracts the most "identifier-like" string from
 *   args (path > id > name > key > url > command > query > first short
 *   string).
 * - Body: typed key/value table — strings monospace, numbers right-aligned
 *   plain, booleans as small pills, objects/arrays collapsed JSON. Long
 *   string values truncate with click-to-expand.
 * - Result: rendered as text if string-ish; otherwise pretty-printed JSON
 *   with the same expand affordance.
 *
 * Plugins that want a custom look can ship their own renderer; this
 * fallback is what they grade against.
 */
export const fallbackRenderer: ToolRenderer = {
  matches: () => true,
  category: "generic",
  Icon: Hexagon,
  formatTarget: (args) => extractIdentifier(args),
  formatSummary: () => undefined,
  Body: ({ args, result, status, error }) => {
    const isObj =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null;
    const entries = isObj ? Object.entries(isObj) : [];
    const text = error ?? resultText(result);
    const objResult =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : null;

    return (
      <ToolBody className="px-0 py-0">
        {/* Args table */}
        {entries.length > 0 && (
          <div className="px-3 py-2">
            <SectionLabel>arguments</SectionLabel>
            <KeyValueTable entries={entries} />
          </div>
        )}

        {/* Result */}
        {status !== "running" && (text || objResult) && (
          <div
            className={cn(
              "px-3 py-2 border-t",
              error
                ? "border-danger-500/30 bg-danger-500/5"
                : "border-[--border]/60 bg-neutral-50/60 dark:bg-neutral-950/60",
            )}
          >
            <SectionLabel tone={error ? "danger" : undefined}>
              {error ? "error" : "result"}
            </SectionLabel>
            {objResult && !text ? (
              <KeyValueTable entries={Object.entries(objResult)} />
            ) : (
              <CollapsedText text={text || "(no output)"} tone={error ? "danger" : undefined} />
            )}
          </div>
        )}

        {status === "running" && (
          <div className="px-3 py-2 text-[11px] text-[--muted] italic font-mono">
            running…
          </div>
        )}
      </ToolBody>
    );
  },
};

const ID_PRIORITY = [
  "path",
  "id",
  "name",
  "key",
  "url",
  "command",
  "query",
  "subject",
  "title",
  "to",
  "channel",
] as const;

function extractIdentifier(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  for (const k of ID_PRIORITY) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0 && v.length < 120) {
      return v.replace(/\s+/g, " ").trim();
    }
  }
  // Fall back to the first short string value.
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.length > 0 && v.length < 80) {
      return v.replace(/\s+/g, " ").trim();
    }
  }
  return undefined;
}

function SectionLabel({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div
      className={cn(
        "text-[9px] uppercase tracking-[0.12em] font-semibold mb-1.5",
        tone === "danger"
          ? "text-danger-600 dark:text-danger-500"
          : "text-[--muted]",
      )}
    >
      {children}
    </div>
  );
}

function KeyValueTable({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[12px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[--muted] font-mono whitespace-nowrap pt-[2px]">{k}</dt>
          <dd className="min-w-0 font-mono">
            <ValueCell value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ValueCell({ value }: { value: unknown }) {
  if (value === null) return <span className="text-[--muted]/70">null</span>;
  if (value === undefined) return <span className="text-[--muted]/70">—</span>;
  if (typeof value === "boolean") {
    return (
      <span
        className={cn(
          "inline-flex items-center px-1 py-[1px] rounded text-[10px] font-medium uppercase tracking-wider",
          value
            ? "bg-success-500/15 text-success-700 dark:text-success-500"
            : "bg-neutral-200/70 dark:bg-neutral-800 text-[--muted]",
        )}
      >
        {String(value)}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="text-[--fg]/95 tabular-nums">{value.toLocaleString()}</span>;
  }
  if (typeof value === "string") {
    return <CollapsedText text={value} inline />;
  }
  // Object / array — render as compact JSON, expandable.
  return <CollapsedJson value={value} />;
}

function CollapsedText({
  text,
  inline,
  tone,
}: {
  text: string;
  inline?: boolean;
  tone?: "danger";
}) {
  const [expanded, setExpanded] = useState(false);
  const SHORT = inline ? 80 : 280;
  const isLong = text.length > SHORT;
  const shown = expanded || !isLong ? text : text.slice(0, SHORT) + "…";
  const cls = cn(
    "whitespace-pre-wrap break-words",
    tone === "danger"
      ? "text-danger-700 dark:text-danger-400"
      : "text-[--fg]/95",
    inline && "text-[12px]",
    !inline && "text-[12px] leading-[1.55]",
  );

  return (
    <span className={cls}>
      {shown}
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-1.5 text-[11px] text-[--muted] hover:text-[--fg] underline-offset-2 hover:underline"
        >
          {expanded ? "less" : "more"}
        </button>
      )}
    </span>
  );
}

function CollapsedJson({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const compact = compactJson(value);
  const isShort = compact.length < 80;

  if (isShort) {
    return <span className="text-[--fg]/85">{compact}</span>;
  }
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-[11px] text-[--muted] hover:text-[--fg] underline-offset-2 hover:underline"
      >
        {Array.isArray(value)
          ? `[${(value as unknown[]).length} items]`
          : `{${Object.keys(value as object).length} keys}`}
      </button>
    );
  }
  return (
    <pre className="text-[11px] leading-snug bg-neutral-100/70 dark:bg-neutral-900/70 rounded px-2 py-1 overflow-x-auto whitespace-pre">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function compactJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s ?? String(value);
  } catch {
    return String(value);
  }
}
