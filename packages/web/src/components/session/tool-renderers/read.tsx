import { FileText } from "lucide-react";
import { PathLabel, ToolBody, TruncatedText } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

function getPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const p = (args as { path?: unknown }).path;
  return typeof p === "string" ? p : "";
}

export const readRenderer: ToolRenderer = {
  matches: "read",
  category: "read",
  Icon: FileText,
  formatTarget: (args) => getPath(args) || undefined,
  formatSummary: (_args, result, status) => {
    if (status === "running") return undefined;
    const text = resultText(result);
    if (!text) return undefined;
    const lines = text.split("\n").length;
    const bytes = new Blob([text]).size;
    return `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"} · ${formatBytes(bytes)}`;
  },
  Body: ({ args, result, status, error }) => {
    const path = getPath(args);
    const text = error ?? resultText(result);

    return (
      <ToolBody className="px-0 py-0">
        {/* Path bar — restates the path in a more visual format. The header
            already shows a truncated path, but here we render it with the
            directory dimmed so the file name pops. */}
        {path && (
          <div className="px-3 py-1.5 border-b border-[--border]/60 bg-neutral-50 dark:bg-neutral-900/60 text-[11px]">
            <PathLabel path={path} />
          </div>
        )}
        <div className="px-2 py-2">
          {status === "running" ? (
            <div className="text-[11px] text-[--muted] italic font-mono">reading…</div>
          ) : text ? (
            <TruncatedText text={text} numbered maxLines={16} />
          ) : (
            <div className="text-[11px] text-[--muted] italic font-mono">(empty file)</div>
          )}
        </div>
      </ToolBody>
    );
  },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
