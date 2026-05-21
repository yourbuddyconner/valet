import { describe, expect, it } from 'vitest';
import {
  buildApprovalResolutionSocketMessage,
  getDefaultApprovalActionId,
  getNextApprovalActionId,
  getApprovalActionDescription,
  getWebSocketErrorText,
  isApprovalPromptExpired,
  markInteractivePromptError,
  markInteractivePromptTerminal,
  pruneTerminalInteractivePrompt,
  upsertInteractivePrompt,
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

  it('detects expired approval prompts from millisecond timestamps', () => {
    expect(isApprovalPromptExpired(undefined, 1_000)).toBe(false);
    expect(isApprovalPromptExpired(999, 1_000)).toBe(true);
    expect(isApprovalPromptExpired(1_000, 1_000)).toBe(true);
    expect(isApprovalPromptExpired(1_001, 1_000)).toBe(false);
  });

  it('replaces an existing prompt when reconnect replays the same pending prompt', () => {
    const existing = { id: 'prompt-1', title: 'Old title', status: 'pending' };
    const replayed = { id: 'prompt-1', title: 'Fresh title', status: 'pending' };

    expect(upsertInteractivePrompt([existing], replayed)).toEqual([replayed]);
  });

  it('extracts websocket error text from the worker message field', () => {
    expect(getWebSocketErrorText({ type: 'error', message: 'This prompt has expired.' })).toBe('This prompt has expired.');
    expect(getWebSocketErrorText({ type: 'error', error: 'Denied by policy.' })).toBe('Denied by policy.');
    expect(getWebSocketErrorText({ type: 'error', content: 'Fallback content.' })).toBe('Fallback content.');
    expect(getWebSocketErrorText({ type: 'error', data: { message: 'Nested error.' } })).toBe('Nested error.');
  });

  it('keeps approval prompts pending but records websocket errors for retry', () => {
    const prompts = [
      { id: 'prompt-1', status: 'pending' as const },
      { id: 'prompt-2', status: 'pending' as const },
    ];

    expect(markInteractivePromptError(prompts, 'prompt-1', 'Unknown approval action')).toEqual([
      { id: 'prompt-1', status: 'pending', error: 'Unknown approval action' },
      { id: 'prompt-2', status: 'pending' },
    ]);
  });

  it('marks prompts terminal locally and prunes only terminal copies', () => {
    const prompts = [
      { id: 'prompt-1', status: 'pending' as const },
      { id: 'prompt-2', status: 'pending' as const },
    ];

    const resolved = markInteractivePromptTerminal(prompts, 'prompt-1', 'resolved');

    expect(resolved).toEqual([
      { id: 'prompt-1', status: 'resolved' },
      { id: 'prompt-2', status: 'pending' },
    ]);
    expect(pruneTerminalInteractivePrompt(resolved, 'prompt-1')).toEqual([
      { id: 'prompt-2', status: 'pending' },
    ]);
    expect(pruneTerminalInteractivePrompt([{ id: 'prompt-1', status: 'pending' }], 'prompt-1')).toEqual([
      { id: 'prompt-1', status: 'pending' },
    ]);
  });
});
