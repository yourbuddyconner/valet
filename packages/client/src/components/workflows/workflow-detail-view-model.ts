export type WorkflowEditorTab = 'editor' | 'executions';

export interface WorkflowEditorTabItem {
  id: WorkflowEditorTab;
  label: string;
}

export function buildWorkflowEditorTabs(executionCount: number): WorkflowEditorTabItem[] {
  return [
    { id: 'editor', label: 'Editor' },
    { id: 'executions', label: executionCount > 0 ? `Runs ${executionCount}` : 'Runs' },
  ];
}

export function getWorkflowEnabledLabel(enabled: boolean): 'Active' | 'Inactive' {
  return enabled ? 'Active' : 'Inactive';
}

export interface WorkflowVersionLike {
  id: string;
  version: number;
  definitionHash: string;
  publishNote?: string;
  createdAt: string;
}

export interface WorkflowVersionRow extends WorkflowVersionLike {
  isActive: boolean;
  hashLabel: string;
}

export function getPublishedVersionLabel(
  publishedVersionId: string | null | undefined,
  versions: WorkflowVersionLike[] | undefined,
): string {
  if (!publishedVersionId) return 'Draft';

  const activeVersion = versions?.find((version) => version.id === publishedVersionId);
  if (!activeVersion) return 'Published';

  return `Published v${activeVersion.version}`;
}

export function getWorkflowVersionHashLabel(definitionHash: string | null | undefined): string {
  if (!definitionHash) return 'unknown';
  return definitionHash.slice(0, 8);
}

export function buildWorkflowVersionRows(
  versions: WorkflowVersionLike[] | undefined,
  publishedVersionId: string | null | undefined,
): WorkflowVersionRow[] {
  return [...(versions ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((version) => ({
      ...version,
      isActive: version.id === publishedVersionId,
      hashLabel: getWorkflowVersionHashLabel(version.definitionHash),
    }));
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
