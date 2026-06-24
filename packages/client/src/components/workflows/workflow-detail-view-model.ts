export type WorkflowEditorTab = 'editor' | 'executions' | 'tests';

export interface WorkflowEditorTabItem {
  id: WorkflowEditorTab;
  label: string;
}

export function buildWorkflowEditorTabs(executionCount: number): WorkflowEditorTabItem[] {
  return [
    { id: 'editor', label: 'Editor' },
    { id: 'executions', label: executionCount > 0 ? `Executions ${executionCount}` : 'Executions' },
    { id: 'tests', label: 'Tests' },
  ];
}

export function getWorkflowEnabledLabel(enabled: boolean): 'Active' | 'Inactive' {
  return enabled ? 'Active' : 'Inactive';
}

export interface PublishButtonStateInput {
  isConfirming: boolean;
  isPending: boolean;
}

export interface PublishButtonState {
  label: 'Publish' | 'Confirm publish' | 'Publishing...';
  title: string;
  isConfirming: boolean;
}

export function getPublishButtonState({
  isConfirming,
  isPending,
}: PublishButtonStateInput): PublishButtonState {
  if (isPending) {
    return {
      label: 'Publishing...',
      title: 'Publishing this workflow version.',
      isConfirming: false,
    };
  }

  if (isConfirming) {
    return {
      label: 'Confirm publish',
      title: 'Click again to publish this draft for triggers.',
      isConfirming: true,
    };
  }

  return {
    label: 'Publish',
    title: 'Publish this draft and make it active for triggers.',
    isConfirming: false,
  };
}
