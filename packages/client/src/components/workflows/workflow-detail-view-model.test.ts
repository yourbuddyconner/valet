import { describe, expect, it } from 'vitest';
import {
  buildWorkflowEditorTabs,
  buildWorkflowVersionRows,
  getPublishButtonState,
  getPublishedVersionLabel,
  getWorkflowVersionHashLabel,
  getWorkflowEnabledLabel,
} from './workflow-detail-view-model';

describe('workflow detail view model', () => {
  it('labels editor tabs with run count when runs exist', () => {
    expect(buildWorkflowEditorTabs(3)).toEqual([
      { id: 'editor', label: 'Editor' },
      { id: 'executions', label: 'Runs 3' },
    ]);
  });

  it('keeps runs tab compact when there are no runs', () => {
    expect(buildWorkflowEditorTabs(0)[1]).toEqual({ id: 'executions', label: 'Runs' });
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

  it('labels the active published version by version number', () => {
    expect(
      getPublishedVersionLabel('version-2', [
        {
          id: 'version-1',
          version: 1,
          definitionHash: '111111111111',
          createdAt: '2026-06-18T12:00:00.000Z',
        },
        {
          id: 'version-2',
          version: 2,
          definitionHash: '222222222222',
          createdAt: '2026-06-18T12:10:00.000Z',
        },
      ]),
    ).toBe('Published v2');
  });

  it('falls back to draft or published when version metadata is unavailable', () => {
    expect(getPublishedVersionLabel(null, [])).toBe('Draft');
    expect(getPublishedVersionLabel('missing-version', [])).toBe('Published');
  });

  it('marks the active workflow version row and sorts newest first', () => {
    expect(
      buildWorkflowVersionRows(
        [
          {
            id: 'version-1',
            version: 1,
            definitionHash: '111111111111',
            createdAt: '2026-06-18T12:00:00.000Z',
          },
          {
            id: 'version-3',
            version: 3,
            definitionHash: '333333333333',
            createdAt: '2026-06-18T12:20:00.000Z',
          },
          {
            id: 'version-2',
            version: 2,
            definitionHash: '222222222222',
            createdAt: '2026-06-18T12:10:00.000Z',
          },
        ],
        'version-2',
      ).map((row) => ({ id: row.id, isActive: row.isActive })),
    ).toEqual([
      { id: 'version-3', isActive: false },
      { id: 'version-2', isActive: true },
      { id: 'version-1', isActive: false },
    ]);
  });

  it('shortens workflow version hashes for compact display', () => {
    expect(getWorkflowVersionHashLabel('abcdef1234567890')).toBe('abcdef12');
    expect(getWorkflowVersionHashLabel('')).toBe('unknown');
  });
});
