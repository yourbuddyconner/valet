import type { LucideIcon } from "lucide-react";
import type { FC } from "react";

/**
 * Visual category — drives the colored left strip + accent for status pulses.
 * Categories group tools by *what they do*, not by their plugin source, so a
 * stripe.create_charge that has "destructive write" semantics can use the
 * same `write` category as our built-in write tool.
 */
export type ToolCategory =
  | "shell" // bash, exec, run-command — terminal-green
  | "read" // read, fetch, query — informational blue
  | "write" // write, create, post — additive green
  | "edit" // edit, patch, modify — amber
  | "thread" // thread_read, mailbox, inbox — violet
  | "generic"; // unknown plugin tools — neutral

export type ToolStatus = "running" | "completed" | "error";

export interface ToolRendererProps {
  args: unknown;
  result: unknown;
  status: ToolStatus;
  error?: string;
}

export interface ToolRenderer {
  /**
   * Tool names this renderer handles. String for exact match, array for
   * multiple, or function for prefix/regex/etc. matching (e.g. plugin
   * registers `stripe.*` to its own renderer).
   */
  matches: string | string[] | ((toolName: string) => boolean);
  category: ToolCategory;
  Icon: LucideIcon;
  /**
   * One-liner shown in the collapsed header strip (right of the tool name).
   * Returns the most recognisable identifier for this tool call — usually
   * a path, command excerpt, or first key of args.
   */
  formatTarget(args: unknown): string | undefined;
  /**
   * Optional compact summary shown on the far right of the header
   * (e.g. "42 lines", "exit 0", "3 messages").
   */
  formatSummary?(args: unknown, result: unknown, status: ToolStatus): string | undefined;
  /** Body view rendered when expanded. */
  Body: FC<ToolRendererProps>;
}

export function matches(renderer: ToolRenderer, toolName: string): boolean {
  const m = renderer.matches;
  if (typeof m === "string") return m === toolName;
  if (Array.isArray(m)) return m.includes(toolName);
  return m(toolName);
}

/** Extract `{ text }` from a tool result, or stringify whatever was returned. */
export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "text" in result) {
    const t = (result as { text: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}
