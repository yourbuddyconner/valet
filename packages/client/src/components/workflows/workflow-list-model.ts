import type { BadgeProps } from '@/components/ui/badge';

export interface WorkflowRowBadgeInput {
  publishedVersionId: string | null;
  enabled: boolean;
}

export interface WorkflowRowBadge {
  label: string;
  variant: BadgeProps['variant'];
}

export function getWorkflowRowBadges({
  publishedVersionId,
  enabled,
}: WorkflowRowBadgeInput): WorkflowRowBadge[] {
  const badges: WorkflowRowBadge[] = [
    publishedVersionId
      ? { label: 'Published', variant: 'success' }
      : { label: 'Draft', variant: 'secondary' },
  ];

  if (!enabled) {
    badges.push({ label: 'Disabled', variant: 'secondary' });
  }

  return badges;
}

export function getWorkflowDeleteDialogCopy(workflowName: string) {
  return {
    title: 'Delete Workflow',
    description: `Are you sure you want to delete "${workflowName}"? This removes the workflow and its triggers. This action cannot be undone.`,
  };
}
