import type {
  CompactionEntry,
  DecisionGate,
  DecisionGateEntry,
  MessageEntry,
  BranchSummaryEntry,
  SessionEntry,
} from "@valet/engine";

export function jsonOrNull<T>(value: T | undefined | null): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function parseJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(value) as T;
}

export interface EntryRow {
  id: string;
  sessionId: string;
  threadId: string;
  parentId: string | null;
  entryType: string;
  role: string | null;
  content: string | null;
  parts: string | null;
  author: string | null;
  channel: string | null;
  model: string | null;
  summary: string | null;
  coveredEntryIds: string | null;
  tokenCountBefore: number | null;
  tokenCountAfter: number | null;
  fileContext: string | null;
  branchRootId: string | null;
  branchLeafId: string | null;
  gateId: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  withdrawnReason: string | null;
  metadata: string | null;
  createdAt: number;
}

export function entryToRow(entry: SessionEntry): EntryRow {
  const base: EntryRow = {
    id: entry.id,
    sessionId: entry.sessionId,
    threadId: entry.threadId,
    parentId: entry.parentId,
    entryType: entry.type,
    role: null,
    content: null,
    parts: null,
    author: null,
    channel: null,
    model: null,
    summary: null,
    coveredEntryIds: null,
    tokenCountBefore: null,
    tokenCountAfter: null,
    fileContext: null,
    branchRootId: null,
    branchLeafId: null,
    gateId: null,
    resolvedAt: null,
    resolution: null,
    withdrawnReason: null,
    metadata: jsonOrNull(entry.metadata),
    createdAt: entry.createdAt,
  };
  switch (entry.type) {
    case "message":
      return {
        ...base,
        role: entry.role,
        content: entry.content,
        parts: jsonOrNull(entry.parts),
        author: jsonOrNull(entry.author),
        channel: jsonOrNull(entry.channel),
        model: entry.model ?? null,
      };
    case "compaction":
      return {
        ...base,
        summary: entry.summary,
        coveredEntryIds: JSON.stringify(entry.coveredEntryIds),
        tokenCountBefore: entry.tokenCountBefore,
        tokenCountAfter: entry.tokenCountAfter,
        fileContext: jsonOrNull(entry.fileContext),
      };
    case "branch_summary":
      return {
        ...base,
        branchRootId: entry.branchRootId,
        branchLeafId: entry.branchLeafId,
        summary: entry.summary,
      };
    case "decision_gate":
      // The gate snapshot lives in metadata under a reserved `gate` key so we
      // don't need a dedicated text column for it.
      return {
        ...base,
        gateId: entry.gate.id,
        metadata: JSON.stringify({ gate: entry.gate, ...(entry.metadata ?? {}) }),
        resolvedAt: entry.resolvedAt ?? null,
        resolution: jsonOrNull(entry.resolution),
        withdrawnReason: entry.withdrawnReason ?? null,
      };
  }
}

export function rowToEntry(row: EntryRow): SessionEntry {
  switch (row.entryType) {
    case "message": {
      const e: MessageEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "message",
        role: (row.role as MessageEntry["role"]) ?? "user",
        content: row.content ?? "",
        parts: parseJson(row.parts),
        author: parseJson(row.author),
        channel: parseJson(row.channel),
        model: row.model ?? undefined,
        metadata: parseJson(row.metadata),
        createdAt: row.createdAt,
      };
      return e;
    }
    case "compaction": {
      const e: CompactionEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "compaction",
        summary: row.summary ?? "",
        coveredEntryIds: parseJson<string[]>(row.coveredEntryIds) ?? [],
        tokenCountBefore: row.tokenCountBefore ?? 0,
        tokenCountAfter: row.tokenCountAfter ?? 0,
        fileContext: parseJson(row.fileContext),
        metadata: parseJson(row.metadata),
        createdAt: row.createdAt,
      };
      return e;
    }
    case "branch_summary": {
      const e: BranchSummaryEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "branch_summary",
        branchRootId: row.branchRootId ?? "",
        branchLeafId: row.branchLeafId ?? "",
        summary: row.summary ?? "",
        metadata: parseJson(row.metadata),
        createdAt: row.createdAt,
      };
      return e;
    }
    case "decision_gate": {
      const meta = parseJson<{ gate: DecisionGate } & Record<string, unknown>>(row.metadata);
      const gate = meta?.gate;
      if (!gate) throw new Error(`decision_gate entry ${row.id} missing gate snapshot`);
      const { gate: _gate, ...userMeta } = meta;
      void _gate;
      const e: DecisionGateEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "decision_gate",
        gate,
        resolvedAt: row.resolvedAt ?? undefined,
        resolution: parseJson(row.resolution),
        withdrawnReason:
          (row.withdrawnReason as DecisionGateEntry["withdrawnReason"]) ?? undefined,
        metadata: Object.keys(userMeta).length > 0 ? (userMeta as Record<string, unknown>) : undefined,
        createdAt: row.createdAt,
      };
      return e;
    }
    default:
      throw new Error(`unknown entry type: ${row.entryType}`);
  }
}
