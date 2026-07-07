/**
 * Shared shape mapper for the "approval view" the workflow-execution UI
 * was built against. Three endpoints assemble this view from different
 * row shapes (Drizzle `actionInvocations` select, raw snake_case rows
 * from the descendant-fan-out CTE, raw rows from the get_execution
 * integration action's D1 prepare()). All of them route through the one
 * helper here so the field-derivation logic — explicit vs tool-policy
 * detection, prompt synthesis from params, etc. — lives in one place.
 */

export interface ApprovalViewInput {
  id: string;
  nodeId: string | null;
  service: string;
  actionId: string;
  status: string;
  /** JSON string from action_invocations.params, or null. */
  params: string | null;
  expiresAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  iterationIndex: number | null;
  /** Set only on descendant fan-out: the session the approval was
   *  raised in, when it's a child of a workflow execution. */
  sessionId?: string | null;
}

export interface ApprovalView {
  id: string;
  nodeId: string | null;
  kind: 'explicit' | 'tool_policy';
  status: string;
  prompt: string | null;
  summary: string | null;
  details: unknown;
  timeoutAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  cancelledAt: null;
  createdAt: string;
  iterationIndex: number | null;
  /** Set when the row came from a session this execution spawned (or
   *  one of its descendants); the UI badges it and deep-links to the
   *  originating session instead of rendering inline buttons. */
  originSessionId?: string | null;
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Map a normalized action_invocations row into the approval view shape.
 * For explicit workflow approvals (service='workflows',
 * actionId='request_approval'), prompt/summary/details are pulled from
 * params. For tool-policy holds, prompt is synthesized from
 * service+actionId and the full params blob is shown as details.
 */
export function mapApprovalView(a: ApprovalViewInput): ApprovalView {
  const parsedParams = a.params ? safeJsonParse(a.params) : null;
  const explicit = a.service === 'workflows' && a.actionId === 'request_approval';
  const p = parsedParams && typeof parsedParams === 'object'
    ? (parsedParams as Record<string, unknown>)
    : {};
  return {
    id: a.id,
    nodeId: a.nodeId,
    kind: explicit ? 'explicit' : 'tool_policy',
    status: a.status,
    prompt: explicit ? ((p.prompt as string | null | undefined) ?? null) : `Approve ${a.service}.${a.actionId}?`,
    summary: explicit ? ((p.summary as string | null | undefined) ?? null) : null,
    details: explicit ? (p.details ?? null) : parsedParams,
    timeoutAt: a.expiresAt,
    resolvedBy: a.resolvedBy,
    resolvedAt: a.resolvedAt,
    cancelledAt: null,
    createdAt: a.createdAt,
    iterationIndex: a.iterationIndex,
    ...(a.sessionId !== undefined ? { originSessionId: a.sessionId } : {}),
  };
}
