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
