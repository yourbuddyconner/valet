export interface ApprovalPromptAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger';
  description?: string;
}

export type ApprovalResolutionSocketMessage =
  | { type: 'approve-action'; invocationId: string; actionId: string }
  | { type: 'deny-action'; invocationId: string; actionId: string };

const DEFAULT_ACTION_DESCRIPTIONS: Record<string, string> = {
  approve: 'Run the tool and continue.',
  allow_once: 'Run the tool and continue.',
  allow_session: 'Run the tool and remember this choice for this session.',
  allow_always: 'Run the tool and remember this choice for future tool calls.',
  deny: 'Cancel this tool call.',
  cancel: 'Cancel this tool call.',
};

export function isApprovalCancelAction(actionId: string): boolean {
  return actionId === 'deny' || actionId === 'cancel';
}

export function buildApprovalResolutionSocketMessage(
  invocationId: string,
  actionId: string,
): ApprovalResolutionSocketMessage {
  return {
    type: isApprovalCancelAction(actionId) ? 'deny-action' : 'approve-action',
    invocationId,
    actionId,
  };
}

export function getDefaultApprovalActionId(actions: ApprovalPromptAction[]): string {
  return actions.find((action) => !isApprovalCancelAction(action.id))?.id ?? actions[0]?.id ?? '';
}

export function getNextApprovalActionId(
  actions: ApprovalPromptAction[],
  currentActionId: string,
  direction: 1 | -1,
): string {
  if (actions.length === 0) return '';
  const currentIndex = actions.findIndex((action) => action.id === currentActionId);
  if (currentIndex === -1) return getDefaultApprovalActionId(actions);
  const nextIndex = (currentIndex + direction + actions.length) % actions.length;
  return actions[nextIndex].id;
}

export function getApprovalActionDescription(action: ApprovalPromptAction): string | undefined {
  return action.description ?? DEFAULT_ACTION_DESCRIPTIONS[action.id];
}

export function isApprovalPromptExpired(expiresAt?: number, now = Date.now()): boolean {
  return typeof expiresAt === 'number' && expiresAt <= now;
}

export function upsertInteractivePrompt<T extends { id: string }>(prompts: T[], prompt: T): T[] {
  const index = prompts.findIndex((existing) => existing.id === prompt.id);
  if (index === -1) return [...prompts, prompt];
  const next = [...prompts];
  next[index] = prompt;
  return next;
}

export interface InteractivePromptVisibility {
  status: 'pending' | 'resolved' | 'expired';
  type?: string;
  channelType?: string;
  channelId?: string;
  threadId?: string;
  context?: Record<string, unknown>;
}

export function getInteractivePromptThreadId(prompt: InteractivePromptVisibility): string | undefined {
  if (prompt.threadId) return prompt.threadId;
  if (typeof prompt.context?.threadId === 'string') return prompt.context.threadId;
  if (prompt.channelType === 'thread' && prompt.channelId) return prompt.channelId;
  if (prompt.context?.channelType === 'thread' && typeof prompt.context.channelId === 'string') {
    return prompt.context.channelId;
  }
  return undefined;
}

export function selectVisibleInteractivePrompts<T extends InteractivePromptVisibility>(
  prompts: T[],
  activeThreadId?: string | null,
): { visible: T[]; queuedCount: number } {
  const resolved = prompts.filter((prompt) => prompt.status !== 'pending');
  const pending = prompts.filter((prompt) => prompt.status === 'pending');
  const scopedPending = activeThreadId
    ? pending.filter((prompt) => getInteractivePromptThreadId(prompt) === activeThreadId)
    : pending;
  const firstPending = scopedPending[0];
  const queuedCount = scopedPending.length - (firstPending ? 1 : 0);
  const visible = firstPending ? [...resolved, firstPending] : resolved;
  return { visible, queuedCount };
}

function requiresUserResponse(prompt: InteractivePromptVisibility): boolean {
  return prompt.type === 'approval' || prompt.type === 'question';
}

export function getPendingResponseRequiredThreadIds<T extends InteractivePromptVisibility>(
  prompts: T[],
): Set<string> {
  const threadIds = new Set<string>();
  for (const prompt of prompts) {
    if (prompt.status !== 'pending' || !requiresUserResponse(prompt)) continue;
    const threadId = getInteractivePromptThreadId(prompt);
    if (threadId) threadIds.add(threadId);
  }
  return threadIds;
}

export function markInteractivePromptTerminal<
  T extends { id: string; status: 'pending' | 'resolved' | 'expired' },
>(
  prompts: T[],
  promptId: string,
  status: 'resolved' | 'expired',
): T[] {
  return prompts.map((prompt) => (
    prompt.id === promptId ? { ...prompt, status } : prompt
  ));
}

export function markInteractivePromptError<
  T extends { id: string; status: 'pending' | 'resolved' | 'expired'; error?: string },
>(
  prompts: T[],
  promptId: string,
  error: string,
): T[] {
  return prompts.map((prompt) => (
    prompt.id === promptId && prompt.status === 'pending'
      ? { ...prompt, error }
      : prompt
  ));
}

export function pruneTerminalInteractivePrompt<
  T extends { id: string; status: 'pending' | 'resolved' | 'expired' },
>(prompts: T[], promptId: string): T[] {
  return prompts.filter((prompt) => prompt.id !== promptId || prompt.status === 'pending');
}

export function getWebSocketErrorText<T extends {
  error?: unknown;
  content?: unknown;
  message?: unknown;
  data?: unknown;
}>(message: T): string {
  const nestedMessage = message.data && typeof message.data === 'object'
    ? (message.data as Record<string, unknown>).message
    : undefined;
  const rawError = message.error ?? message.content ?? message.message ?? nestedMessage ?? 'Unknown error';
  if (typeof rawError === 'string') return rawError;
  if (rawError && typeof rawError === 'object') {
    const objectMessage = (rawError as Record<string, unknown>).message;
    return typeof objectMessage === 'string' ? objectMessage : JSON.stringify(rawError);
  }
  return String(rawError);
}

export function getWebSocketErrorPromptId<T extends {
  promptId?: unknown;
  data?: unknown;
}>(message: T): string | undefined {
  if (typeof message.promptId === 'string') return message.promptId;
  if (message.data && typeof message.data === 'object') {
    const nestedPromptId = (message.data as Record<string, unknown>).promptId;
    if (typeof nestedPromptId === 'string') return nestedPromptId;
  }
  return undefined;
}
