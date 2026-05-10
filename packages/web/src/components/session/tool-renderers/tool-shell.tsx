import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "~/lib/cn";
import type { ToolCategory, ToolStatus } from "./types";

/**
 * The shared chrome that wraps every tool-call rendering. Categorical color
 * lives on the left strip + status accents; the body slot is owned by the
 * specific tool renderer. While `running`, a thin scanner sweeps the header
 * — same animation regardless of tool, in the category color, signalling
 * "the agent is working" without shouting.
 */
export interface ToolShellProps {
  toolName: string;
  category: ToolCategory;
  Icon: LucideIcon;
  /** Right-of-name primary identifier (path, command excerpt, key, etc.). */
  target?: string;
  /** Far-right compact summary (e.g. "42 lines", "exit 0"). */
  summary?: string;
  status: ToolStatus;
  /** Body content; rendered inside the expandable section. */
  children: ReactNode;
  /** Default expanded state. Off by default for completed/error to keep
   *  the chat dense; on while running so the user sees progress. */
  defaultExpanded?: boolean;
}

const CATEGORY_STRIP: Record<ToolCategory, string> = {
  shell: "bg-emerald-600 dark:bg-emerald-500",
  read: "bg-sky-600 dark:bg-sky-500",
  write: "bg-emerald-600 dark:bg-emerald-500",
  edit: "bg-amber-600 dark:bg-amber-500",
  thread: "bg-violet-600 dark:bg-violet-500",
  generic: "bg-neutral-400 dark:bg-neutral-600",
};

const CATEGORY_TEXT: Record<ToolCategory, string> = {
  shell: "text-emerald-700 dark:text-emerald-400",
  read: "text-sky-700 dark:text-sky-400",
  write: "text-emerald-700 dark:text-emerald-400",
  edit: "text-amber-700 dark:text-amber-400",
  thread: "text-violet-700 dark:text-violet-400",
  generic: "text-neutral-600 dark:text-neutral-400",
};

const STATUS_DOT: Record<ToolStatus, string> = {
  running: "bg-current",
  completed: "bg-success-600 dark:bg-success-500",
  error: "bg-danger-600 dark:bg-danger-500",
};

export function ToolShell({
  toolName,
  category,
  Icon,
  target,
  summary,
  status,
  children,
  defaultExpanded,
}: ToolShellProps) {
  const initial = defaultExpanded ?? (status !== "completed");
  const [expanded, setExpanded] = useState(initial);
  const stripCls = STATUS_DOT[status];
  const isError = status === "error";

  return (
    <section
      className={cn(
        "group/tool relative flex overflow-hidden rounded-md border bg-[--bg]",
        isError
          ? "border-danger-500/40"
          : "border-[--border]",
      )}
    >
      {/* Category strip — 2px on the left edge, color-coded by tool family. */}
      <div
        aria-hidden
        className={cn("w-[2px] shrink-0", CATEGORY_STRIP[category])}
      />

      <div className="flex-1 min-w-0">
        {/* Header: clickable to toggle expansion. The scanner-line overlay
            only animates while running, in the category color. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "relative w-full flex items-center gap-2 px-2.5 py-1.5",
            "text-left text-xs font-mono leading-none",
            "hover:bg-neutral-50 dark:hover:bg-neutral-900/40",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40",
            "transition-colors",
          )}
          aria-expanded={expanded}
          aria-controls={`tool-body-${toolName}`}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-[--muted] transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
          <Icon
            className={cn("h-3.5 w-3.5 shrink-0", CATEGORY_TEXT[category])}
            aria-hidden
          />
          <span
            className={cn(
              "shrink-0 uppercase tracking-[0.08em] text-[10px] font-semibold",
              CATEGORY_TEXT[category],
            )}
          >
            {toolName}
          </span>
          {target && (
            <span className="truncate text-[--fg]/85 min-w-0 flex-1">
              {target}
            </span>
          )}
          {!target && <span className="flex-1" />}
          {summary && (
            <span className="shrink-0 text-[--muted] text-[11px]">
              {summary}
            </span>
          )}
          <StatusPip status={status} />

          {/* Scanner overlay — only active while running. The gradient sweeps
              left→right behind the header content, low-alpha, in the
              category color via currentColor. */}
          {status === "running" && (
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 pointer-events-none overflow-hidden",
                CATEGORY_TEXT[category],
              )}
            >
              <span
                className="absolute inset-y-0 -left-1/3 w-1/3 opacity-[0.18]"
                style={{
                  background:
                    "linear-gradient(90deg, transparent, currentColor, transparent)",
                  animation: "tool-scan 1.6s ease-in-out infinite",
                }}
              />
            </span>
          )}
        </button>

        {/* Body */}
        {expanded && (
          <div
            id={`tool-body-${toolName}`}
            className={cn(
              "border-t border-[--border]",
              isError && "border-t-danger-500/30",
            )}
          >
            {children}
          </div>
        )}
      </div>

      {/* Scanner keyframes — scoped to a global keyframes name; defining
          here as a style tag is the pragmatic approach since the project
          doesn't have a CSS layer for animations beyond the Tailwind
          extension. */}
      <style>{`
        @keyframes tool-scan {
          0%   { transform: translateX(0%); }
          50%  { transform: translateX(380%); }
          100% { transform: translateX(0%); }
        }
      `}</style>
    </section>
  );
}

function StatusPip({ status }: { status: ToolStatus }) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-medium",
        status === "running" && "text-[--muted]",
        status === "completed" && "text-success-600 dark:text-success-500",
        status === "error" && "text-danger-600 dark:text-danger-500",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          STATUS_DOT[status],
          status === "running" && "animate-pulse",
        )}
      />
      {status === "running" ? "running" : status === "completed" ? "done" : "error"}
    </span>
  );
}

/**
 * Thin code-block-like body container. Most tool renderers use this as
 * their root body element. Pads, monospaces, and applies a subtle inset
 * tint that distinguishes the body from the header.
 */
export function ToolBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-2.5 py-2 bg-neutral-50/50 dark:bg-neutral-950/40",
        "text-[12px] leading-snug",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Truncated text block: shows the first `maxLines` lines of `text` and a
 * "show all" affordance for the rest. Used for raw outputs / file contents
 * that may be arbitrarily long.
 */
export function TruncatedText({
  text,
  maxLines = 12,
  numbered = false,
  className,
}: {
  text: string;
  maxLines?: number;
  numbered?: boolean;
  className?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = text.split("\n");
  const truncated = !showAll && lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;
  const hidden = lines.length - visible.length;

  return (
    <div className={cn("font-mono text-[12px] leading-[1.55]", className)}>
      <pre className="whitespace-pre overflow-x-auto">
        {visible.map((line, i) => (
          <div key={i} className="flex">
            {numbered && (
              <span
                aria-hidden
                className="select-none w-9 pr-3 text-right text-[--muted]/60 shrink-0"
              >
                {i + 1}
              </span>
            )}
            <span className="text-[--fg]/90 min-w-0">{line || " "}</span>
          </div>
        ))}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1.5 text-[11px] text-[--muted] hover:text-[--fg] underline-offset-2 hover:underline"
        >
          + {hidden} more {hidden === 1 ? "line" : "lines"}
        </button>
      )}
    </div>
  );
}

/**
 * Format a path with the directory prefix muted and the filename emphasised.
 * Ubiquitous in the read/write/edit renderers.
 */
export function PathLabel({ path, className }: { path: string; className?: string }) {
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return (
    <span className={cn("font-mono", className)}>
      {dir && <span className="text-[--muted]/80">{dir}</span>}
      <span className="text-[--fg]/95">{name}</span>
    </span>
  );
}
