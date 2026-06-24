import { describe, expect, it } from 'vitest';
import {
  buildWorkflowEditorTabs,
  getPublishButtonState,
  getWorkflowEnabledLabel,
} from './workflow-detail-view-model';

describe('workflow detail view model', () => {
  it('labels editor tabs with execution count when executions exist', () => {
    expect(buildWorkflowEditorTabs(3)).toEqual([
      { id: 'editor', label: 'Editor' },
      { id: 'executions', label: 'Executions 3' },
      { id: 'tests', label: 'Tests' },
    ]);
  });

  it('keeps executions tab compact when there are no executions', () => {
    expect(buildWorkflowEditorTabs(0)[1]).toEqual({ id: 'executions', label: 'Executions' });
  });

  it('returns the toolbar status label from enabled state', () => {
    expect(getWorkflowEnabledLabel(true)).toBe('Active');
    expect(getWorkflowEnabledLabel(false)).toBe('Inactive');
  });

  it('uses distinct publish labels for the idle, confirming, and pending states', () => {
    expect(getPublishButtonState({ isConfirming: false, isPending: false })).toEqual({
      label: 'Publish',
      title: 'Publish this draft and make it active for triggers.',
      isConfirming: false,
    });
    expect(getPublishButtonState({ isConfirming: true, isPending: false })).toEqual({
      label: 'Confirm publish',
      title: 'Click again to publish this draft for triggers.',
      isConfirming: true,
    });
    expect(getPublishButtonState({ isConfirming: true, isPending: true })).toEqual({
      label: 'Publishing...',
      title: 'Publishing this workflow version.',
      isConfirming: false,
    });
  });
});
