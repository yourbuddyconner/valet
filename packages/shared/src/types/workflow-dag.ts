/**
 * Workflow DAG (`dag/v1`) type definitions.
 *
 * The canonical shape of user-authored workflow definitions interpreted
 * by the Cloudflare Workflow runtime. See docs/specs/workflows.md.
 */

// ─── Top-level definition ────────────────────────────────────────────────────

export interface WorkflowDefinition {
  version: 'dag/v1';
  inputs?: Record<string, WorkflowInputDefinition>;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  policy?: WorkflowPolicy;
  ui?: WorkflowEditorState;
}

export interface WorkflowInputDefinition {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
  description?: string;
  enum?: unknown[];
}

export interface WorkflowPolicy {
  maxNodes?: number;
  maxConcurrentNodes?: number;
  maxWaitDurationMs?: number;
  maxForeachItems?: number;
  maxForeachConcurrency?: number;
}

export interface WorkflowEditorState {
  nodes: Record<string, {
    position: { x: number; y: number };
    collapsed?: boolean;
  }>;
  viewport?: { x: number; y: number; zoom: number };
}

// ─── Edges ──────────────────────────────────────────────────────────────────

export interface WorkflowEdge {
  from: string;
  to: string;
  fromOutput?: 'true' | 'false';
  when?: string;
}

// ─── Node discriminated union ───────────────────────────────────────────────

export type WorkflowNode =
  | LlmNode
  | IfNode
  | ForeachNode
  | ApprovalNode
  | WaitNode
  | SetNode
  | StopNode
  | ToolNode
  | OrchestratorNode
  | SessionNode;

export interface LlmNode {
  id: string;
  type: 'llm';
  model?: string;
  system?: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface IfNode {
  id: string;
  type: 'if';
  combinator?: 'and' | 'or';
  conditions: IfCondition[];
}

export interface IfCondition {
  left: string;
  dataType: 'string' | 'number' | 'date' | 'boolean' | 'array' | 'object';
  operation: string;
  right?: unknown;
}

export interface ForeachNode {
  id: string;
  type: 'foreach';
  items: string;
  body: ForeachBodyNode;
  maxItems?: number;
  concurrency?: number;
  itemAlias?: string;
  indexAlias?: string;
  onItemError?: 'fail' | 'skip' | 'collect';
}

// Body of a foreach is restricted — no nested foreach, no if (control flow at
// the DAG level), no approval. The runtime executes one per item.
export type ForeachBodyNode =
  | LlmNode
  | ToolNode
  | SetNode
  | StopNode
  | OrchestratorNode
  | SessionNode;

export interface ApprovalNode {
  id: string;
  type: 'approval';
  prompt: string;
  summary?: string;
  details?: unknown;
  timeout?: string;
  onDeny?: 'fail' | 'skip';
}

export interface WaitNode {
  id: string;
  type: 'wait';
  mode: 'duration';
  duration: string;
}

export interface SetNode {
  id: string;
  type: 'set';
  values: unknown;
}

export interface StopNode {
  id: string;
  type: 'stop';
  outcome?: 'success' | 'failure';
  output?: unknown;
  message?: string;
}

export interface ToolNode {
  id: string;
  type: 'tool';
  service: string;
  action: string;
  params: Record<string, unknown>;
  summary?: string;
  onPolicyDeny?: 'fail' | 'skip';
  retries?: number;
}

export interface OrchestratorNode {
  id: string;
  type: 'orchestrator';
  prompt: string;
  forceNewThread?: boolean;
  wait?: {
    mode: 'none' | 'until_idle';
    timeout?: string;
  };
}

// Session node — discriminated on `mode`.
export type SessionNode = StartSessionNode | PromptSessionNode;

export interface StartSessionNode {
  id: string;
  type: 'session';
  mode: 'start';
  prompt: string;
  workspace: string;
  title?: string;
  personaId?: string;
  model?: string;
  repo?: {
    url?: string;
    branch?: string;
    ref?: string;
    sourceRepoFullName?: string;
  };
  wait?: {
    mode: 'none' | 'until_idle';
    timeout?: string;
  };
}

export interface PromptSessionNode {
  id: string;
  type: 'session';
  mode: 'prompt';
  sessionId: string;
  prompt: string;
  threadId?: string;
  forceNewThread?: boolean;
  wait?: {
    mode: 'none' | 'until_idle';
    timeout?: string;
  };
}

// ─── Runtime payloads ────────────────────────────────────────────────────────

export interface WorkflowTriggerPayload {
  type: 'manual' | 'schedule' | 'webhook';
  triggerId?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface WorkflowDagState {
  trigger: WorkflowTriggerPayload;
  inputs: Record<string, unknown>;
  nodes: Record<string, WorkflowNodeOutput>;
  skipped: Record<string, { reason: string }>;
  /** Optional: edge-eval errors captured by the runtime so downstream
   * skip rows can surface the underlying cause instead of a generic
   * "no inbound edge satisfied" string. */
  edgeErrors?: Record<string, string>;
  /** Cumulative foreach iteration count across the entire execution.
   * Per spec the 5001st iteration aborts the workflow. */
  foreachIterationCount?: number;
}

export interface WorkflowNodeOutput {
  status: 'completed' | 'skipped' | 'failed';
  data?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
}

// ─── Validation errors ──────────────────────────────────────────────────────

export interface WorkflowValidationError {
  scope: 'workflow' | 'node' | 'edge' | 'field' | 'input';
  nodeId?: string;
  edgeId?: string;
  inputName?: string;
  path?: string;
  code: string;
  message: string;
}
