import { describe, expect, it } from 'vitest';
import { driveActionDefs } from '../drive-actions.js';
import { docsActionDefs } from '../docs-actions.js';
import { sheetsActionDefs } from '../sheets-actions.js';

function propertySchema(actionId: string, property: string): Record<string, unknown> | undefined {
  const action = [...driveActionDefs, ...docsActionDefs, ...sheetsActionDefs].find((def) => def.id === actionId);
  const properties = action?.outputSchema?.properties;
  if (!properties || typeof properties !== 'object') return undefined;
  return (properties as Record<string, Record<string, unknown>>)[property];
}

describe('Google Workspace action output schemas', () => {
  it('declares an output schema for every action', () => {
    const missing = [...driveActionDefs, ...docsActionDefs, ...sheetsActionDefs]
      .filter((def) => !def.outputSchema)
      .map((def) => def.id);

    expect(missing).toEqual([]);
  });

  it('marks list/search results as typed arrays for workflow data-flow discovery', () => {
    expect(propertySchema('drive.list_files', 'files')?.type).toBe('array');
    expect(propertySchema('drive.list_documents', 'documents')?.type).toBe('array');
    expect(propertySchema('drive.list_folder_contents', 'folders')?.type).toBe('array');
    expect(propertySchema('drive.list_folder_contents', 'files')?.type).toBe('array');
    expect(propertySchema('sheets.list_spreadsheets', 'spreadsheets')?.type).toBe('array');
    expect(propertySchema('docs.list_tabs', 'tabs')?.type).toBe('array');
    expect(propertySchema('docs.list_comments', 'comments')?.type).toBe('array');
  });
});
