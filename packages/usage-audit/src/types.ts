// Public types for @valet/usage-audit. Shared by data sources, runner, and CLI.

export type Category =
  | 'automation-trigger'
  | 'orchestrator-chat'
  | 'orchestrator-internal'
  | 'ad-hoc';

export const CATEGORIES: readonly Category[] = [
  'automation-trigger',
  'orchestrator-chat',
  'orchestrator-internal',
  'ad-hoc',
] as const;

export type LabelDimension = 'taskType' | 'costDriver' | 'outcome';

export const LABEL_DIMENSIONS: readonly LabelDimension[] = [
  'taskType',
  'costDriver',
  'outcome',
] as const;

// Row shape after joining session_threads → sessions.
export interface ThreadRow {
  threadId: string;
  sessionId: string;
  userId: string;
  userEmail: string | null;
  isOrchestrator: boolean;
  purpose: string;
  originType: string | null;
  originChannelType: string | null;
  originChannelId: string | null;
  originTriggerId: string | null;
  originTriggerType: string | null;
  threadTitle: string | null;
  sessionTitle: string | null;
}

// Per-(model) breakdown inside a thread.
export interface ModelTokenBreakdown {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

// Aggregated tokens + tools for a thread.
export interface ThreadTotals {
  threadId: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  toolCalls: number;
  modelBreakdown: Record<string, ModelTokenBreakdown>;
  toolHistogram: Array<{ toolName: string; calls: number }>;
  firstCallAt: string;
  lastCallAt: string;
}

export interface MessageRow {
  id: string;
  threadId: string | null;
  sessionId: string;
  role: string;
  content: string;
  channelType: string | null;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  title: string | null;
  parentSessionId: string | null;
  isOrchestrator: boolean;
}

export interface CategorizedThread {
  thread: ThreadRow;
  totals: ThreadTotals;
  category: Category;
}

// Output of the classifier.
export interface Classification {
  taskType: string;
  costDriver: string;
  outcome: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
}

// One line in classifications.jsonl.
export interface ClassificationLine {
  threadId: string;
  sessionId: string;
  category: Category;
  classifiedAt: string;
  model: string;
  input: { digest: string };
  output: Classification;
}

export interface LabelEntry {
  label: string;
  firstSeenThreadId: string;
  firstSeenSummary: string;
  addedAt: string;
}

export interface LabelRegistry {
  list(dimension: LabelDimension): Promise<LabelEntry[]>;
  add(
    dimension: LabelDimension,
    label: string,
    threadId: string,
    summary: string,
  ): Promise<{ added: boolean; normalized: string }>;
  normalize(label: string): string;
}

// Diagnostic measuring how well analytics_events.turn_id joins to messages.turn_id.
export interface JoinDiagnostic {
  llmCallRows: number;
  joinedToMessage: number;
  hitRate: number;
}

export interface UsageDataSource {
  diagnostic(from: Date, to: Date): Promise<JoinDiagnostic>;
  // Returns ThreadTotals keyed by threadId for every thread that had at least
  // one llm_call event in the window. Threads that exist but had no llm_call
  // events are omitted.
  fetchThreadTotals(from: Date, to: Date): Promise<Map<string, ThreadTotals>>;
  fetchThreads(threadIds: string[]): Promise<ThreadRow[]>;
  fetchThreadMessages(threadId: string): Promise<MessageRow[]>;
  fetchSession(sessionId: string): Promise<SessionRow | null>;
  // Used by the report (top users / model leaderboard need user emails) but
  // not by the per-thread classification loop.
  fetchUsers(userIds: string[]): Promise<Map<string, { id: string; email: string | null }>>;
}

export interface AuditOptions {
  from: Date;
  to: Date;
  env: 'dev' | 'prod';
  dataSource: UsageDataSource;
  labels: LabelRegistry;
  classifier?: ClassifierFn; // optional → skip classification
  classificationSink: ClassificationSink;
  model: 'haiku' | 'sonnet';
  outDir: string;
  resume: boolean;
  concurrency: number;
  logger?: (msg: string) => void;
}

export interface AuditResult {
  attribution: Attribution;
  classificationCount: number;
  diagnostic: JoinDiagnostic;
  labelsIntroduced: Record<LabelDimension, LabelEntry[]>;
  reportPath: string;
  attributionPath: string;
  classificationsPath: string;
}

export type ClassifierFn = (input: {
  digest: string;
  preferredLabels: Record<LabelDimension, string[]>;
  model: 'haiku' | 'sonnet';
}) => Promise<Classification>;

export interface ClassificationSink {
  // Returns the set of thread IDs already classified (for --resume).
  completedThreadIds(): Promise<Set<string>>;
  append(line: ClassificationLine): Promise<void>;
}

// Attribution roll-up shapes (consumed by the report generator).
export interface Attribution {
  meta: {
    from: string;
    to: string;
    env: 'dev' | 'prod';
    generatedAt: string;
    classifierModel: 'haiku' | 'sonnet' | null;
    totalThreads: number;
    totalLlmCalls: number;
    joinHitRate: number;
  };
  totals: {
    inputTokens: number;
    outputTokens: number;
    byCategory: Record<Category, { threads: number; llmCalls: number; inputTokens: number; outputTokens: number }>;
    byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
    unattributed: { llmCalls: number; inputTokens: number; outputTokens: number };
  };
  byUser: Array<{
    userId: string;
    email: string | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    threadCount: number;
    byCategory: Record<Category, { threads: number; inputTokens: number; outputTokens: number }>;
  }>;
  byModel: Array<{ model: string; calls: number; inputTokens: number; outputTokens: number; avgInputPerCall: number }>;
  topThreads: Array<{
    rank: number;
    threadId: string;
    sessionId: string;
    category: Category;
    userId: string;
    userEmail: string | null;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    topTools: Array<{ toolName: string; calls: number }>;
    firstMessagePreview: string;
    classification: Classification | null;
  }>;
  daily: Array<{ date: string; byCategory: Record<Category, { inputTokens: number; outputTokens: number }> }>;
  toolLeaderboard: Array<{ toolName: string; calls: number; inputTokens: number; share: number }>;
}
