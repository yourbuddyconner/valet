import type { ActionContext, ActionResult } from '@valet/sdk/integrations';
import { normalizeDocumentId } from './docs-helpers.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DriveLabelsGuardConfig {
  driveLabelsGuardEnabled: boolean;
  driveRequiredLabelIds: string[];
  driveLabelsFailMode: 'deny' | 'allow';
}

export type GuardAction = 'list_search' | 'read_get' | 'write_modify' | 'create' | 'unknown';

// ─── Action Classification ──────────────────────────────────────────────────

export const LIST_SEARCH_ACTIONS: string[] = [
  'drive.list_files',
  'drive.search_files',
  'drive.list_documents',
  'drive.search_documents',
  'drive.list_folder_contents',
  'sheets.list_spreadsheets',
];

export const READ_GET_ACTIONS: string[] = [
  'drive.get_document_info',
  'drive.get_folder_info',
  'drive.download_file',
  'docs.read_document',
  'docs.list_tabs',
  'docs.list_comments',
  'docs.get_comment',
  'docs.find_text_index',
  'sheets.read_spreadsheet',
  'sheets.get_spreadsheet_info',
  'sheets.read_cell_format',
  'sheets.get_table',
  'sheets.list_tables',
  'sheets.get_conditional_formatting',
];

export const WRITE_MODIFY_ACTIONS: string[] = [
  'drive.copy_file',
  'drive.move_file',
  'drive.rename_file',
  'drive.delete_file',
  'docs.insert_text',
  'docs.append_text',
  'docs.modify_text',
  'docs.delete_range',
  'docs.find_and_replace',
  'docs.append_markdown',
  'docs.replace_document_with_markdown',
  'docs.insert_table',
  'docs.insert_table_with_data',
  'docs.insert_image',
  'docs.insert_page_break',
  'docs.insert_section_break',
  'docs.add_tab',
  'docs.rename_tab',
  'docs.apply_text_style',
  'docs.apply_paragraph_style',
  'docs.update_section_style',
  'docs.add_comment',
  'docs.reply_to_comment',
  'docs.delete_comment',
  'docs.resolve_comment',
  'sheets.write_spreadsheet',
  'sheets.append_rows',
  'sheets.batch_write',
  'sheets.clear_range',
  'sheets.add_sheet',
  'sheets.delete_sheet',
  'sheets.rename_sheet',
  'sheets.duplicate_sheet',
  'sheets.copy_sheet_to',
  'sheets.format_cells',
  'sheets.copy_formatting',
  'sheets.set_column_widths',
  'sheets.set_row_heights',
  'sheets.auto_resize_columns',
  'sheets.auto_resize_rows',
  'sheets.set_cell_borders',
  'sheets.freeze_rows_and_columns',
  'sheets.delete_table',
  'sheets.update_table_range',
  'sheets.append_table_rows',
  'sheets.group_rows',
  'sheets.ungroup_all_rows',
  'sheets.insert_chart',
  'sheets.delete_chart',
  'sheets.add_conditional_formatting',
  'sheets.delete_conditional_formatting',
  'sheets.set_dropdown_validation',
  'sheets.protect_range',
];

export const CREATE_ACTIONS: string[] = [
  'drive.create_document',
  'drive.create_folder',
  'drive.create_from_template',
  'sheets.create_spreadsheet',
  'sheets.create_table',
];

// ─── Guard Config Parsing ───────────────────────────────────────────────────

/**
 * Parse guard config from ActionContext. Returns null if the guard is disabled
 * or the config is missing.
 */
/** Google Drive label IDs are alphanumeric with possible hyphens/underscores. */
const LABEL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function resolveGuard(ctx: ActionContext): DriveLabelsGuardConfig | null {
  const cfg = ctx.guardConfig;
  if (!cfg) return null;
  if (!cfg.driveLabelsGuardEnabled) return null;

  const labelIds = Array.isArray(cfg.driveRequiredLabelIds)
    ? (cfg.driveRequiredLabelIds as string[]).filter(
        (id) => typeof id === 'string' && id.length > 0 && LABEL_ID_PATTERN.test(id),
      )
    : [];

  const failMode = cfg.driveLabelsFailMode === 'allow' ? 'allow' : 'deny';

  return {
    driveLabelsGuardEnabled: true,
    driveRequiredLabelIds: labelIds,
    driveLabelsFailMode: failMode,
  };
}

// ─── Query Filter ───────────────────────────────────────────────────────────

/**
 * Build a parenthesized OR clause for Drive API query filtering by label IDs.
 * - 0 labels: returns ''
 * - 1 label: returns `'labels/{id}' in labels`
 * - N labels: returns `('labels/{id1}' in labels OR 'labels/{id2}' in labels)`
 *
 * Parenthesization is required to prevent Drive API operator precedence bugs
 * when combined with AND clauses.
 */
export function buildLabelFilterClause(labelIds: string[]): string {
  if (labelIds.length === 0) return '';
  const parts = labelIds.map((id) => `'labels/${id}' in labels`);
  if (parts.length === 1) return parts[0];
  return `(${parts.join(' OR ')})`;
}

// ─── File Label Check ───────────────────────────────────────────────────────

/**
 * Check whether a file has at least one of the required labels.
 * Returns an ActionResult denial if the file does not have a required label,
 * or null if the file passes the check.
 */
export async function checkFileLabel(
  fileId: string,
  token: string,
  config: DriveLabelsGuardConfig,
): Promise<ActionResult | null> {
  // Enabled guard + no required labels = deny all
  if (config.driveRequiredLabelIds.length === 0) {
    return { success: false, error: 'File not found or access denied' };
  }

  const includeLabels = config.driveRequiredLabelIds.join(',');
  const qs = new URLSearchParams({
    includeLabels,
    fields: 'labelInfo',
    supportsAllDrives: 'true',
  });

  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${qs}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!res.ok) {
      if (res.status === 401) {
        // Surface 401 so session-tools auth-retry can refresh the token
        return { success: false, error: 'Drive API 401: unauthorized during label check' };
      }
      // Other API error — respect failMode
      if (config.driveLabelsFailMode === 'allow') return null;
      return { success: false, error: 'File not found or access denied' };
    }

    const data = (await res.json()) as {
      labelInfo?: { labels?: Array<{ id: string }> };
    };

    const labels = data.labelInfo?.labels;
    if (!labels || labels.length === 0) {
      // No matching labels — intentionally indistinguishable from 404
      return { success: false, error: 'File not found or access denied' };
    }

    // File has at least one required label — pass
    return null;
  } catch {
    // Network/parse error — respect failMode
    if (config.driveLabelsFailMode === 'allow') return null;
    return { success: false, error: 'File not found or access denied' };
  }
}

// ─── Auto-Label on Create ───────────────────────────────────────────────────

/**
 * Apply a Drive label to a file via the modifyLabels endpoint.
 * Returns true on success, false on failure.
 */
export async function applyLabel(
  fileId: string,
  token: string,
  labelId: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/modifyLabels`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          labelModifications: [{ labelId, fieldModifications: [] }],
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort file deletion for rollback when auto-label fails on a newly created file.
 */
export async function deleteFile(fileId: string, token: string): Promise<void> {
  try {
    await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );
  } catch {
    // best-effort — ignore errors
  }
}

// ─── Action Classification ──────────────────────────────────────────────────

const classificationMap = new Map<string, GuardAction>();
for (const id of LIST_SEARCH_ACTIONS) classificationMap.set(id, 'list_search');
for (const id of READ_GET_ACTIONS) classificationMap.set(id, 'read_get');
for (const id of WRITE_MODIFY_ACTIONS) classificationMap.set(id, 'write_modify');
for (const id of CREATE_ACTIONS) classificationMap.set(id, 'create');

/** Classify an action ID into its guard category. */
export function classifyAction(actionId: string): GuardAction {
  return classificationMap.get(actionId) ?? 'unknown';
}

// ─── File ID Extraction Helpers ─────────────────────────────────────────────

/**
 * Extract the file ID from action params based on the action prefix.
 * Drive actions use `fileId`, Docs use `documentId`, Sheets use `spreadsheetId`.
 */
export function extractFileId(actionId: string, params: Record<string, unknown>): string | null {
  if (actionId === 'drive.get_folder_info') {
    return typeof params.folderId === 'string' ? params.folderId : null;
  }
  if (actionId === 'drive.create_from_template') {
    return typeof params.templateId === 'string' ? params.templateId : null;
  }
  if (actionId.startsWith('drive.')) {
    return typeof params.fileId === 'string' ? params.fileId : null;
  }
  if (actionId.startsWith('docs.')) {
    return typeof params.documentId === 'string' ? normalizeDocumentId(params.documentId) : null;
  }
  if (actionId === 'sheets.copy_sheet_to') {
    return typeof params.sourceSpreadsheetId === 'string' ? params.sourceSpreadsheetId : null;
  }
  if (actionId.startsWith('sheets.')) {
    return typeof params.spreadsheetId === 'string' ? params.spreadsheetId : null;
  }
  return null;
}

/**
 * Extract the created file ID from a successful action result.
 * Drive: result.data.id, Docs: result.data.documentId, Sheets: result.data.spreadsheetId
 */
export function extractCreatedFileId(
  actionId: string,
  result: ActionResult,
): string | null {
  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return null;

  if (actionId.startsWith('drive.')) {
    return typeof data.id === 'string' ? data.id : null;
  }
  if (actionId.startsWith('docs.')) {
    return typeof data.documentId === 'string' ? data.documentId : null;
  }
  if (actionId.startsWith('sheets.')) {
    return typeof data.spreadsheetId === 'string' ? data.spreadsheetId : null;
  }
  return null;
}
