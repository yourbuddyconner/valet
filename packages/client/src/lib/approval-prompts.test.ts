import { describe, expect, it } from 'vitest';
import {
  buildApprovalResolutionSocketMessage,
  getDefaultApprovalActionId,
  getNextApprovalActionId,
  getApprovalActionDescription,
} from './approval-prompts';

const approvalActions = [
  { id: 'allow_once', label: 'Allow' },
  { id: 'allow_session', label: 'Allow for Session' },
  { id: 'allow_always', label: 'Always Allow' },
  { id: 'cancel', label: 'Cancel' },
];

describe('approval prompt helpers', () => {
  it('routes allow choices through the approve-action socket message with the selected action id', () => {
    expect(buildApprovalResolutionSocketMessage('inv-1', 'allow_session')).toEqual({
      type: 'approve-action',
      invocationId: 'inv-1',
      actionId: 'allow_session',
    });

    expect(buildApprovalResolutionSocketMessage('inv-1', 'allow_always')).toEqual({
      type: 'approve-action',
      invocationId: 'inv-1',
      actionId: 'allow_always',
    });
  });

  it('routes cancel choices through the deny-action socket message with the selected action id', () => {
    expect(buildApprovalResolutionSocketMessage('inv-2', 'cancel')).toEqual({
      type: 'deny-action',
      invocationId: 'inv-2',
      actionId: 'cancel',
    });

    expect(buildApprovalResolutionSocketMessage('inv-2', 'deny')).toEqual({
      type: 'deny-action',
      invocationId: 'inv-2',
      actionId: 'deny',
    });
  });

  it('selects the first non-cancel choice by default', () => {
    expect(getDefaultApprovalActionId(approvalActions)).toBe('allow_once');
    expect(getDefaultApprovalActionId([{ id: 'cancel', label: 'Cancel' }, ...approvalActions])).toBe('allow_once');
  });

  it('cycles the selected action with keyboard-style movement', () => {
    expect(getNextApprovalActionId(approvalActions, 'allow_once', 1)).toBe('allow_session');
    expect(getNextApprovalActionId(approvalActions, 'allow_once', -1)).toBe('cancel');
    expect(getNextApprovalActionId(approvalActions, 'missing', 1)).toBe('allow_once');
  });

  it('uses server-provided descriptions and falls back for standard approval actions', () => {
    expect(getApprovalActionDescription({ id: 'allow_session', label: 'Allow for Session' })).toBe('Run the tool and remember this choice for this session.');
    expect(getApprovalActionDescription({ id: 'custom', label: 'Custom', description: 'Custom behavior.' })).toBe('Custom behavior.');
    expect(getApprovalActionDescription({ id: 'custom', label: 'Custom' })).toBeUndefined();
  });
});
