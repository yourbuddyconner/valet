import { Terminal } from "lucide-react";
import { cn } from "~/lib/cn";
import { ToolBody, TruncatedText } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

interface BashArgs {
  command?: unknown;
}

function getCommand(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const c = (args as BashArgs).command;
  return typeof c === "string" ? c : "";
}

/**
 * The command excerpt shown in the header — single-line, character-budgeted.
 * For multi-line commands, collapses whitespace so the header stays clean
 * (the full command renders in the body).
 */
function commandExcerpt(command: string, max = 80): string {
  const flat = command.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

/** Pull the trailing `[exit N]` annotation our engine adds to non-zero exits. */
function parseExit(text: string): { body: string; exit?: number } {
  const m = text.match(/\n\[exit (-?\d+)\]\s*$/);
  if (!m) return { body: text };
  return { body: text.slice(0, m.index ?? 0), exit: Number(m[1]) };
}

export const bashRenderer: ToolRenderer = {
  matches: "bash",
  category: "shell",
  Icon: Terminal,
  formatTarget: (args) => commandExcerpt(getCommand(args)) || undefined,
  formatSummary: (_args, result, status) => {
    if (status !== "completed" && status !== "error") return undefined;
    const text = resultText(result);
    if (!text) return undefined;
    const { exit } = parseExit(text);
    if (exit === undefined) return undefined;
    return `exit ${exit}`;
  },
  Body: ({ args, result, status, error }) => {
    const command = getCommand(args);
    const raw = error ?? resultText(result);
    const { body, exit } = parseExit(raw);

    return (
      <ToolBody className="bg-neutral-950 dark:bg-black text-emerald-300/95 px-0 py-0">
        {/* Command line, terminal-prompt style. */}
        {command && (
          <div className="px-3 py-2 border-b border-emerald-500/15 flex gap-2">
            <span aria-hidden className="select-none text-emerald-400/80">
              $
            </span>
            <pre className="font-mono text-[12px] leading-snug whitespace-pre-wrap break-all flex-1 text-emerald-100/95">
              {command}
            </pre>
          </div>
        )}
        {/* Output. While running, show a subtle blinking caret. */}
        <div className="px-3 py-2">
          {status === "running" && !body ? (
            <BlinkingCaret />
          ) : body ? (
            <TruncatedText
              text={body}
              className={cn(
                "text-[12px]",
                status === "error"
                  ? "text-danger-400"
                  : "text-neutral-200/90",
              )}
            />
          ) : (
            <div className="text-[11px] text-neutral-500 italic">
              {status === "error" ? "(no output)" : "(empty output)"}
            </div>
          )}
          {exit !== undefined && exit !== 0 && (
            <div className="mt-2 text-[10px] uppercase tracking-wider text-danger-400">
              process exited with code {exit}
            </div>
          )}
        </div>
      </ToolBody>
    );
  },
};

function BlinkingCaret() {
  return (
    <span
      className="inline-block w-[7px] h-[14px] bg-emerald-300 align-middle"
      style={{ animation: "tool-blink 1s step-end infinite" }}
    >
      <style>{`
        @keyframes tool-blink {
          0%, 50% { opacity: 1; }
          50.01%, 100% { opacity: 0; }
        }
      `}</style>
    </span>
  );
}
