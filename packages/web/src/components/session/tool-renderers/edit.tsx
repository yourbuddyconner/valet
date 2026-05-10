import { Pencil } from "lucide-react";
import { PathLabel, ToolBody } from "./tool-shell";
import { DiffLine } from "./write";
import { resultText, type ToolRenderer } from "./types";

interface EditArgs {
  path?: unknown;
  // Engine builtin uses these names; plugin variants might differ.
  old_string?: unknown;
  new_string?: unknown;
  oldString?: unknown;
  newString?: unknown;
}

function getPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const p = (args as EditArgs).path;
  return typeof p === "string" ? p : "";
}

function getOld(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as EditArgs;
  return typeof a.old_string === "string"
    ? a.old_string
    : typeof a.oldString === "string"
      ? a.oldString
      : "";
}

function getNew(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as EditArgs;
  return typeof a.new_string === "string"
    ? a.new_string
    : typeof a.newString === "string"
      ? a.newString
      : "";
}

export const editRenderer: ToolRenderer = {
  matches: "edit",
  category: "edit",
  Icon: Pencil,
  formatTarget: (args) => getPath(args) || undefined,
  formatSummary: (args, _result, status) => {
    if (status === "running") return undefined;
    const oldLines = getOld(args).split("\n").length;
    const newLines = getNew(args).split("\n").length;
    return `−${oldLines} +${newLines}`;
  },
  Body: ({ args, status, result, error }) => {
    const path = getPath(args);
    const before = getOld(args);
    const after = getNew(args);
    const failed =
      status === "error" ||
      resultText(result).startsWith("no match for old_string");

    return (
      <ToolBody className="px-0 py-0">
        {path && (
          <div className="px-3 py-1.5 border-b border-[--border]/60 bg-neutral-50 dark:bg-neutral-900/60 text-[11px] flex items-center justify-between gap-2">
            <PathLabel path={path} />
            {failed && (
              <span className="text-danger-600 dark:text-danger-500 text-[10px] uppercase tracking-wider">
                {error ? "failed" : "no match"}
              </span>
            )}
          </div>
        )}
        {status === "running" ? (
          <div className="px-3 py-2 text-[11px] text-[--muted] italic font-mono">editing…</div>
        ) : (
          <div className="font-mono text-[12px] leading-[1.55] py-1">
            <pre className="whitespace-pre overflow-x-auto">
              {before.split("\n").map((line, i) => (
                <DiffLine key={`o-${i}`} kind="remove" line={line} />
              ))}
              {after.split("\n").map((line, i) => (
                <DiffLine key={`n-${i}`} kind="add" line={line} />
              ))}
            </pre>
          </div>
        )}
        {failed && resultText(result) && (
          <div className="px-3 py-2 border-t border-danger-500/30 bg-danger-500/5 text-[11px] text-danger-700 dark:text-danger-400 font-mono">
            {resultText(result)}
          </div>
        )}
      </ToolBody>
    );
  },
};
