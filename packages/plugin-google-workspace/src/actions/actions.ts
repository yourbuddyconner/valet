import type { ActionContext, ActionDefinition, ActionResult, ActionSource, IntegrationPackage } from '@valet/sdk/integrations';
import { googleWorkspaceProvider } from './provider.js';
import { driveActionDefs, executeDriveAction } from './drive-actions.js';
import { docsActionDefs, executeDocsAction } from './docs-actions.js';
import { sheetsActionDefs, executeSheetsAction } from './sheets-actions.js';
import {
  resolveGuard,
  classifyAction,
  buildLabelFilterClause,
  checkFileLabel,
  applyLabel,
  deleteFile,
  extractFileId,
  extractCreatedFileId,
} from './labels-guard.js';

const allActions: ActionDefinition[] = [
  ...driveActionDefs,
  ...docsActionDefs,
  ...sheetsActionDefs,
];

function dispatchAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  if (actionId.startsWith('drive.')) return executeDriveAction(actionId, params, ctx);
  if (actionId.startsWith('docs.')) return executeDocsAction(actionId, params, ctx);
  if (actionId.startsWith('sheets.')) return executeSheetsAction(actionId, params, ctx);
  return Promise.resolve({ success: false, error: `Unknown action: ${actionId}` });
}

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  // Strip any agent-supplied __labelFilter — only the guard may set this
  delete (params as Record<string, unknown>).__labelFilter;

  const guard = resolveGuard(ctx);
  if (!guard) return dispatchAction(actionId, params, ctx);

  const token = ctx.credentials.access_token || '';
  const category = classifyAction(actionId);

  // Fail-closed: unclassified actions are denied when the guard is active.
  // Surface the actual action ID — this is a caller bug (e.g. hallucinated tool
  // name), not a label check, so the error should be diagnosable.
  if (category === 'unknown') {
    return { success: false, error: `Unknown action: ${actionId}` };
  }

  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;

  // ── Pre-dispatch guards ──

  if (category === 'list_search') {
    // When the guard is enabled with no required labels, deny all results
    if (guard.driveRequiredLabelIds.length === 0) {
      return { success: true, data: { files: [] } };
    }
    // Inject label filter clause into params for search/list actions
    const clause = buildLabelFilterClause(guard.driveRequiredLabelIds);
    if (clause) {
      (p as Record<string, unknown>).__labelFilter = clause;
    }
    return dispatchAction(actionId, p, ctx);
  }

  // ── drive.copy_file: source-file label check + dispatch + auto-label copy ──

  if (actionId === 'drive.copy_file') {
    const fileId = extractFileId(actionId, p);
    if (!fileId) {
      if (guard.driveLabelsFailMode === 'allow') return dispatchAction(actionId, params, ctx);
      return { success: false, error: 'File not found or access denied' };
    }
    const denial = await checkFileLabel(fileId, token, guard);
    if (denial) return denial;

    const result = await dispatchAction(actionId, params, ctx);
    if (result.success && guard.driveRequiredLabelIds.length > 0) {
      const createdId = extractCreatedFileId(actionId, result);
      if (createdId) {
        const labeled = await applyLabel(createdId, token, guard.driveRequiredLabelIds[0]);
        if (!labeled) {
          await deleteFile(createdId, token);
          return {
            success: false,
            error: 'Failed to create file: could not apply required Drive label',
          };
        }
      }
    }
    return result;
  }

  // ── drive.create_from_template: template label check + dispatch + auto-label ──

  if (actionId === 'drive.create_from_template') {
    const templateId = typeof p.templateId === 'string' ? p.templateId : null;
    if (!templateId) {
      if (guard.driveLabelsFailMode === 'allow') return dispatchAction(actionId, params, ctx);
      return { success: false, error: 'File not found or access denied' };
    }
    const denial = await checkFileLabel(templateId, token, guard);
    if (denial) return denial;

    const result = await dispatchAction(actionId, params, ctx);
    if (result.success && guard.driveRequiredLabelIds.length > 0) {
      const createdId = extractCreatedFileId(actionId, result);
      if (createdId) {
        const labeled = await applyLabel(createdId, token, guard.driveRequiredLabelIds[0]);
        if (!labeled) {
          await deleteFile(createdId, token);
          return {
            success: false,
            error: 'Failed to create file: could not apply required Drive label',
          };
        }
      }
    }
    return result;
  }

  // ── sheets.copy_sheet_to: check both source and destination spreadsheets ──

  if (actionId === 'sheets.copy_sheet_to') {
    const sourceId = typeof p.sourceSpreadsheetId === 'string' ? p.sourceSpreadsheetId : null;
    const destId = typeof p.destinationSpreadsheetId === 'string' ? p.destinationSpreadsheetId : null;
    if (!sourceId || !destId) {
      if (guard.driveLabelsFailMode === 'allow') return dispatchAction(actionId, params, ctx);
      return { success: false, error: 'File not found or access denied' };
    }
    const sourceDenial = await checkFileLabel(sourceId, token, guard);
    if (sourceDenial) return sourceDenial;
    const destDenial = await checkFileLabel(destId, token, guard);
    if (destDenial) return destDenial;
    return dispatchAction(actionId, params, ctx);
  }

  if (category === 'read_get' || category === 'write_modify') {
    const fileId = extractFileId(actionId, p);
    if (!fileId) {
      if (guard.driveLabelsFailMode === 'allow') return dispatchAction(actionId, params, ctx);
      return { success: false, error: 'File not found or access denied' };
    }
    const denial = await checkFileLabel(fileId, token, guard);
    if (denial) return denial;
    return dispatchAction(actionId, params, ctx);
  }

  // ── Dispatch for create actions ──

  if (category === 'create') {
    // Guard active + no required labels: deny creates to prevent orphaned files
    if (guard.driveRequiredLabelIds.length === 0) {
      return { success: false, error: 'File not found or access denied' };
    }
  }

  const result = await dispatchAction(actionId, params, ctx);

  // ── Post-dispatch: cleanup partial creates + auto-label ──

  if (category === 'create') {
    // If dispatch failed but a file was partially created, clean it up
    if (!result.success) {
      const partialId = extractCreatedFileId(actionId, result);
      if (partialId) {
        await deleteFile(partialId, token);
      }
      return result;
    }

    if (guard.driveRequiredLabelIds.length > 0) {
      const createdId = extractCreatedFileId(actionId, result);
      if (createdId) {
        const labeled = await applyLabel(createdId, token, guard.driveRequiredLabelIds[0]);
        if (!labeled) {
          // Roll back the created file
          await deleteFile(createdId, token);
          return {
            success: false,
            error: 'Failed to create file: could not apply required Drive label',
          };
        }
      }
    }
  }

  return result;
}

const actions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};

export const googleWorkspacePackage: IntegrationPackage = {
  name: 'google-workspace',
  version: '0.0.1',
  service: 'google_workspace',
  provider: googleWorkspaceProvider,
  actions,
};
