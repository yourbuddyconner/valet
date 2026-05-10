import { FilePlus2 } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/cn";
import { PathLabel, ToolBody } from "./tool-shell";
import type { ToolRenderer } from "./types";

interface WriteArgs {
  path?: unknown;
  content?: unknown;
}

function getPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const p = (args as WriteArgs).path;
  return typeof p === "string" ? p : "";
}

function getContent(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const c = (args as WriteArgs).content;
  return typeof c === "string" ? c : "";
}

export const writeRenderer: ToolRenderer = {
  matches: "write",
  category: "write",
  Icon: FilePlus2,
  formatTarget: (args) => getPath(args) || undefined,
  formatSummary: (args, _result, status) => {
    if (status === "running") return undefined;
    const lines = getContent(args).split("\n").length;
    return `+${lines} ${lines === 1 ? "line" : "lines"}`;
  },
  Body: ({ args, status, error }) => {
    const path = getPath(args);
    const content = getContent(args);

    return (
      <ToolBody className="px-0 py-0">
        {path && (
          <div className="px-3 py-1.5 border-b border-[--border]/60 bg-neutral-50 dark:bg-neutral-900/60 text-[11px] flex items-center justify-between gap-2">
            <PathLabel path={path} />
            {error && (
              <span className="text-danger-600 dark:text-danger-500 text-[10px] uppercase tracking-wider">
                failed
              </span>
            )}
          </div>
        )}
        {status === "running" && !content ? (
          <div className="px-3 py-2 text-[11px] text-[--muted] italic font-mono">
            writing…
          </div>
        ) : (
          <DiffAdditions text={content} />
        )}
        {error && (
          <div className="px-3 py-2 border-t border-danger-500/30 bg-danger-500/5 text-[11px] text-danger-700 dark:text-danger-400 font-mono whitespace-pre-wrap">
            {error}
          </div>
        )}
      </ToolBody>
    );
  },
};

/**
 * Renders a block of text as added lines (green "+" prefix). Used by write
 * (whole content is "added") and as a building block for edit's after-block.
 */
export function DiffAdditions({
  text,
  maxLines = 14,
}: {
  text: string;
  maxLines?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = text.split("\n");
  const truncated = !showAll && lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;
  const hidden = lines.length - visible.length;

  return (
    <div className="font-mono text-[12px] leading-[1.55]">
      <pre className="whitespace-pre overflow-x-auto py-1">
        {visible.map((line, i) => (
          <DiffLine key={i} kind="add" line={line} />
        ))}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="ml-3 mb-2 text-[11px] text-[--muted] hover:text-[--fg] underline-offset-2 hover:underline"
        >
          + {hidden} more {hidden === 1 ? "line" : "lines"}
        </button>
      )}
    </div>
  );
}

export function DiffLine({
  kind,
  line,
}: {
  kind: "add" | "remove" | "context";
  line: string;
}) {
  const sigil = kind === "add" ? "+" : kind === "remove" ? "−" : " ";
  return (
    <div
      className={cn(
        "flex pl-2",
        kind === "add" &&
          "bg-emerald-500/[0.07] dark:bg-emerald-400/[0.06]",
        kind === "remove" &&
          "bg-danger-500/[0.07] dark:bg-danger-400/[0.06]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "select-none w-5 shrink-0 text-center",
          kind === "add" && "text-emerald-600 dark:text-emerald-400",
          kind === "remove" && "text-danger-600 dark:text-danger-400",
          kind === "context" && "text-[--muted]/50",
        )}
      >
        {sigil}
      </span>
      <span
        className={cn(
          "min-w-0",
          kind === "add" && "text-emerald-900 dark:text-emerald-100",
          kind === "remove" && "text-danger-900 dark:text-danger-100",
          kind === "context" && "text-[--fg]/85",
        )}
      >
        {line || " "}
      </span>
    </div>
  );
}
