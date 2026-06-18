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
