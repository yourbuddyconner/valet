import { completeSimple } from "@mariozechner/pi-ai";
import type { Message, Model } from "@mariozechner/pi-ai";
import type {
  CompactionConfig,
  MessageEntry,
  SessionEntry,
} from "./types.js";

/**
 * Compaction primitives — all pure functions. Orchestration that calls an
 * LLM and persists results lives in the orchestrator (see compactThread in
 * thread.ts). Keeping these pure makes them trivially unit-testable
 * against synthetic transcripts.
 */

// ── Constants and defaults ─────────────────────────────────────────

const DEFAULTS = {
  reserveCap: 20_000,
  tailTurns: 2,
  minPreserveRecentTokens: 2_000,
  maxPreserveRecentTokens: 8_000,
  pruneProtectTokens: 40_000,
  pruneMinimumTokens: 20_000,
  toolOutputMaxChars: 2_000,
} as const;

const DEFAULT_PROTECTED_TOOLS = new Set(["skill", "thread_read"]);

// ── Token estimation ───────────────────────────────────────────────

/**
 * Crude byte-based token estimate. We estimate ~4 chars per token, which
 * matches the heuristic OpenCode and pi-ai both use for budgeting decisions.
 * Provider-reported token counts (from pi-ai usage) are used where available;
 * this estimator is for offline budgeting (cut-point selection, prune budget).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateEntryTokens(entry: SessionEntry): number {
  if (entry.type === "message") {
    let total = estimateTokens(entry.content);
    for (const part of entry.parts ?? []) {
      if (part.type === "text") total += estimateTokens(part.text);
      else if (part.type === "thinking") total += estimateTokens(part.text);
      else if (part.type === "tool_call") {
        if (part.args) total += estimateTokens(JSON.stringify(part.args));
        if (part.result !== undefined && !part.elided) {
          total += estimateTokens(typeof part.result === "string" ? part.result : JSON.stringify(part.result));
        }
        if (part.error) total += estimateTokens(part.error);
      }
    }
    return total;
  }
  if (entry.type === "compaction") return estimateTokens(entry.summary);
  if (entry.type === "branch_summary") return estimateTokens(entry.summary);
  return 0; // decision_gate adds negligible context tokens
}

export function estimateTotalTokens(entries: readonly SessionEntry[]): number {
  let total = 0;
  for (const e of entries) total += estimateEntryTokens(e);
  return total;
}

// ── Usable budget ──────────────────────────────────────────────────

export function usableTokens(model: Model<any>, cfg?: CompactionConfig): number {
  const context = model.contextWindow ?? 0;
  if (context === 0) return 0;
  const reserve =
    cfg?.reserveTokens ?? Math.min(DEFAULTS.reserveCap, model.maxTokens ?? DEFAULTS.reserveCap);
  return Math.max(0, context - reserve);
}

export function tailBudget(usable: number, cfg?: CompactionConfig): number {
  const min = cfg?.minPreserveRecentTokens ?? DEFAULTS.minPreserveRecentTokens;
  const max = cfg?.maxPreserveRecentTokens ?? DEFAULTS.maxPreserveRecentTokens;
  const target = Math.floor(usable * 0.25);
  return clamp(target, min, max);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ── Turn segmentation ──────────────────────────────────────────────

export interface Turn {
  /** Index into the entries array of the user message that starts this turn. */
  start: number;
  /** Index of the next user-message turn boundary, or entries.length if last. */
  end: number;
  /** Entry id of the user message at `start`. */
  id: string;
}

/**
 * Segment a list of entries into turns. A turn = [user message, ...everything until next user message).
 * Decision gates and compaction entries that fall mid-turn stay in their owning turn.
 * Existing CompactionEntry markers are NOT turn boundaries — they sit at the head as a
 * single virtual prefix. The first turn starts at the first user message after any
 * leading non-message entries (which usually means index 0).
 */
export function turns(entries: readonly SessionEntry[]): Turn[] {
  const result: Turn[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "message" || e.role !== "user") continue;
    result.push({ start: i, end: entries.length, id: e.id });
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start;
  }
  return result;
}

// ── Cut-point selection ────────────────────────────────────────────

export interface CutPoint {
  /** Entries before this index go into the head (to be compacted). */
  cutIndex: number;
  /** Entry id where the tail starts, or undefined if the tail is empty. */
  tailStartId: string | undefined;
  /** True if we couldn't fit a full tail-turn budget; we kept what we could. */
  fallbackToFloor: boolean;
}

export interface SelectCutPointOptions {
  entries: readonly SessionEntry[];
  model: Model<any>;
  cfg?: CompactionConfig;
  /** Override token estimator for tests. Defaults to estimateEntryTokens. */
  tokenize?: (entry: SessionEntry) => number;
}

/**
 * Pick a cut point so the tail (kept verbatim) fits within the tail budget
 * derived from the model's usable context. Mirrors OpenCode's select():
 *
 * - Compute tail budget from `usable * 0.25` clamped to [min, max].
 * - Take the last `tailTurns` turns and walk them oldest → newest from the end,
 *   accumulating size. Keep adding whole turns until the next one would
 *   overflow. If the very next (older) turn alone is too large to fit, split
 *   it: scan inside the turn for an entry whose suffix slice fits the
 *   remaining budget, and cut there.
 * - If no tail can be preserved (e.g. the very last turn alone exceeds the
 *   budget and can't be split), keep the last turn anyway with
 *   fallbackToFloor=true so the orchestrator can decide to abort or proceed.
 */
export function selectCutPoint(opts: SelectCutPointOptions): CutPoint {
  const { entries, model, cfg } = opts;
  const tokenize = opts.tokenize ?? estimateEntryTokens;
  const tailTurnsLimit = cfg?.tailTurns ?? DEFAULTS.tailTurns;
  if (entries.length === 0 || tailTurnsLimit <= 0) {
    return { cutIndex: entries.length, tailStartId: undefined, fallbackToFloor: false };
  }

  const usable = usableTokens(model, cfg);
  const budget = tailBudget(usable, cfg);
  const allTurns = turns(entries);
  if (allTurns.length === 0) {
    return { cutIndex: entries.length, tailStartId: undefined, fallbackToFloor: false };
  }

  // Take the last tailTurnsLimit turns as candidates for the tail.
  const candidates = allTurns.slice(-tailTurnsLimit);

  // Walk newest → oldest, accumulating whole turns until we can't fit one.
  let used = 0;
  let keepStart = -1;
  let keepStartId: string | undefined;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const turn = candidates[i];
    const size = sumRange(entries, turn.start, turn.end, tokenize);
    if (used + size <= budget) {
      used += size;
      keepStart = turn.start;
      keepStartId = turn.id;
      continue;
    }
    // This older turn can't fit whole — try to split it.
    const remaining = budget - used;
    const split = splitTurnForBudget({
      entries,
      turn,
      budget: remaining,
      tokenize,
    });
    if (split !== undefined) {
      keepStart = split.cutIndex;
      keepStartId = split.startId;
    }
    break;
  }

  if (keepStart < 0) {
    // Couldn't fit even the last turn within the tail budget. Floor: keep
    // the most recent turn anyway so we always make progress.
    const last = candidates[candidates.length - 1];
    return {
      cutIndex: last.start,
      tailStartId: last.id,
      fallbackToFloor: true,
    };
  }

  return { cutIndex: keepStart, tailStartId: keepStartId, fallbackToFloor: false };
}

interface TurnSplit {
  cutIndex: number;
  startId: string;
}

function splitTurnForBudget(args: {
  entries: readonly SessionEntry[];
  turn: Turn;
  budget: number;
  tokenize: (entry: SessionEntry) => number;
}): TurnSplit | undefined {
  if (args.budget <= 0) return undefined;
  if (args.turn.end - args.turn.start <= 1) return undefined;
  // Try later and later split points until the suffix fits.
  for (let start = args.turn.start + 1; start < args.turn.end; start++) {
    const size = sumRange(args.entries, start, args.turn.end, args.tokenize);
    if (size <= args.budget) {
      const id = args.entries[start]?.id;
      if (!id) return undefined;
      return { cutIndex: start, startId: id };
    }
  }
  return undefined;
}

function sumRange(
  entries: readonly SessionEntry[],
  start: number,
  end: number,
  tokenize: (entry: SessionEntry) => number,
): number {
  let total = 0;
  for (let i = start; i < end; i++) total += tokenize(entries[i]);
  return total;
}

// ── Pruning (cheap, no LLM) ────────────────────────────────────────

export interface PruneOptions {
  entries: readonly SessionEntry[];
  cfg?: CompactionConfig;
  /** Tool names exempt from pruning. Merged with cfg.protectedTools and ToolDef.protectedFromPruning. */
  protectedTools?: Set<string>;
}

export interface PruneResult {
  /** entryId → list of tool_call callIds to mark elided (only filled if savedTokens >= pruneMinimumTokens). */
  toElide: Map<string, string[]>;
  savedTokens: number;
  /** True if we'll commit (savedTokens >= pruneMinimumTokens). */
  willCommit: boolean;
}

/**
 * Walk entries newest → oldest. Track cumulative tool-output token estimate.
 * Once the cumulative count exceeds `pruneProtectTokens`, mark every older
 * tool-call result as elidable. Skip protected tools and tool calls that
 * already have `elided: true`.
 */
export function planPrune(opts: PruneOptions): PruneResult {
  const cfg = opts.cfg;
  const protectTokens = cfg?.pruneProtectTokens ?? DEFAULTS.pruneProtectTokens;
  const minimumTokens = cfg?.pruneMinimumTokens ?? DEFAULTS.pruneMinimumTokens;
  const protectedTools = mergeProtectedTools(opts.protectedTools, cfg?.protectedTools);

  const toElide = new Map<string, string[]>();
  let cumulative = 0;
  let savedTokens = 0;

  for (let i = opts.entries.length - 1; i >= 0; i--) {
    const entry = opts.entries[i];
    if (entry.type !== "message") continue;
    if (!entry.parts) continue;
    for (const part of entry.parts) {
      if (part.type !== "tool_call") continue;
      if (part.status !== "completed") continue;
      if (part.elided) continue;
      if (protectedTools.has(part.toolName)) continue;
      const resultText =
        part.result === undefined
          ? ""
          : typeof part.result === "string"
          ? part.result
          : JSON.stringify(part.result);
      const size = estimateTokens(resultText);
      cumulative += size;
      if (cumulative <= protectTokens) continue;
      // Past the protection window — mark this tool result for elision.
      const list = toElide.get(entry.id) ?? [];
      list.push(part.callId);
      toElide.set(entry.id, list);
      savedTokens += size;
    }
  }

  return {
    toElide,
    savedTokens,
    willCommit: savedTokens >= minimumTokens,
  };
}

function mergeProtectedTools(
  base: Set<string> | undefined,
  fromCfg: string[] | undefined,
): Set<string> {
  const out = new Set<string>(DEFAULT_PROTECTED_TOOLS);
  if (base) for (const t of base) out.add(t);
  if (fromCfg) for (const t of fromCfg) out.add(t);
  return out;
}

/**
 * Apply a PruneResult to the entries by mutating the matching tool_call parts.
 * The caller is responsible for persisting the mutation back to the SessionStore.
 */
export function applyPrune(entries: SessionEntry[], plan: PruneResult): void {
  if (!plan.willCommit) return;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const elideIds = plan.toElide.get(entry.id);
    if (!elideIds || elideIds.length === 0) continue;
    const idSet = new Set(elideIds);
    for (const part of entry.parts ?? []) {
      if (part.type !== "tool_call") continue;
      if (!idSet.has(part.callId)) continue;
      part.elided = true;
      part.result = { elided: true, reason: "pruned" };
    }
  }
}

// ── File context extraction ────────────────────────────────────────

const READ_TOOLS = new Set(["read", "grep", "glob"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * Walk the head entries' tool calls and pull out file paths, classifying
 * each as `read` (tool was a reader) or `modified` (tool was a writer).
 */
export function extractFileContext(
  entries: readonly SessionEntry[],
): { read: string[]; modified: string[] } {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    for (const part of entry.parts ?? []) {
      if (part.type !== "tool_call") continue;
      const path = extractPath(part.args);
      if (!path) continue;
      if (READ_TOOLS.has(part.toolName)) read.add(path);
      else if (WRITE_TOOLS.has(part.toolName)) modified.add(path);
    }
  }
  return { read: [...read], modified: [...modified] };
}

function extractPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  const candidate = obj.path ?? obj.file ?? obj.filename ?? obj.target;
  return typeof candidate === "string" ? candidate : undefined;
}

// ── Summarizer ─────────────────────────────────────────────────────

/**
 * The required structured-markdown template. The engine relies on this
 * shape downstream (e.g. for displaying a session-resume note) — keep
 * sections in this exact order and casing. OpenCode pioneered this layout;
 * we copy it verbatim because it works.
 */
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

export interface SummarizeOptions {
  /** Entries to summarize (the head — everything before the cut point). */
  headEntries: readonly SessionEntry[];
  /** Model to use for the summarization call. */
  model: Model<any>;
  /** Truncate tool outputs to this many chars before feeding to the LLM. */
  toolOutputMaxChars?: number;
  /**
   * Existing summary from a prior compaction; the prompt asks the
   * summarizer to update this rather than write a fresh one.
   */
  previousSummary?: string;
  /** Optional API key override (forwarded to pi-ai). */
  apiKey?: string;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface SummarizeResult {
  summary: string;
  inputTokens: number;
  outputTokens: number;
}

export async function summarize(opts: SummarizeOptions): Promise<SummarizeResult> {
  const messages = entriesToSummaryMessages(opts.headEntries, {
    toolOutputMaxChars: opts.toolOutputMaxChars ?? DEFAULTS.toolOutputMaxChars,
  });
  const anchor = opts.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        opts.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above.";
  const prompt = `${anchor}\n\n${SUMMARY_TEMPLATE}`;

  const result = await completeSimple(opts.model, {
    systemPrompt:
      "You are a session compaction summarizer. Produce a concise, structured summary that lets a coding agent resume work without the original transcript.",
    messages: [
      ...messages,
      { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
    ],
  }, {
    apiKey: opts.apiKey,
    signal: opts.signal,
  });

  const text = result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    summary: text.trim(),
    inputTokens: result.usage.input + result.usage.cacheRead,
    outputTokens: result.usage.output,
  };
}

/**
 * Convert engine SessionEntries to pi-ai Messages for feeding to the
 * summarizer. We strip image attachments (they don't help summarization
 * and can hit byte limits) and truncate large tool outputs.
 */
export function entriesToSummaryMessages(
  entries: readonly SessionEntry[],
  opts: { toolOutputMaxChars: number },
): Message[] {
  const out: Message[] = [];
  for (const e of entries) {
    if (e.type !== "message") continue; // skip CompactionEntry, DecisionGateEntry, BranchSummary
    if (e.role === "user") {
      out.push({
        role: "user",
        content: [{ type: "text", text: e.content }],
        timestamp: e.createdAt,
      });
      continue;
    }
    if (e.role === "assistant") {
      const blocks: Array<{ type: "text"; text: string }> = [];
      const parts = e.parts ?? [];
      const hadStructured = parts.length > 0;
      for (const p of parts) {
        if (p.type === "text") blocks.push({ type: "text", text: p.text });
        else if (p.type === "thinking") {
          // Drop thinking from summary input — it's redundant once we have the result.
        } else if (p.type === "tool_call") {
          const argsStr = p.args ? JSON.stringify(p.args) : "";
          let resultStr = "";
          if (p.elided) resultStr = "[output elided to save context]";
          else if (p.result !== undefined) {
            const raw = typeof p.result === "string" ? p.result : JSON.stringify(p.result);
            resultStr =
              raw.length > opts.toolOutputMaxChars
                ? raw.slice(0, opts.toolOutputMaxChars) + `…(truncated, ${raw.length - opts.toolOutputMaxChars} more chars)`
                : raw;
          }
          blocks.push({
            type: "text",
            text: `[tool: ${p.toolName}] args=${argsStr} result=${resultStr}`,
          });
        }
      }
      if (!hadStructured && e.content) blocks.push({ type: "text", text: e.content });
      if (blocks.length === 0) continue;
      out.push({
        role: "assistant",
        content: blocks,
        api: "summarizer-input",
        provider: "summarizer-input",
        model: "n/a",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: e.createdAt,
      });
    }
  }
  return out;
}
