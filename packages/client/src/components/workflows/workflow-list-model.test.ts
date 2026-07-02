import { describe, expect, it } from 'vitest';
import { getWorkflowRowBadges, getWorkflowDeleteDialogCopy } from './workflow-list-model';

describe('workflow list view model', () => {
  it('shows published and disabled badges for an inactive published workflow', () => {
    expect(
      getWorkflowRowBadges({
        publishedVersionId: 'version-1',
        enabled: false,
      }),
    ).toEqual([
      { label: 'Published', variant: 'success' },
      { label: 'Disabled', variant: 'secondary' },
    ]);
  });

  it('shows draft badge for an unpublished workflow', () => {
    expect(
      getWorkflowRowBadges({
        publishedVersionId: null,
        enabled: true,
      }),
    ).toEqual([{ label: 'Draft', variant: 'secondary' }]);
  });

  it('uses the workflow name in delete confirmation copy', () => {
    expect(getWorkflowDeleteDialogCopy('Daily triage')).toEqual({
      title: 'Delete Workflow',
      description:
        'Are you sure you want to delete "Daily triage"? This removes the workflow and its triggers. This action cannot be undone.',
    });
  });
});
