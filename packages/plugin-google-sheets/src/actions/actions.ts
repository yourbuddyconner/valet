import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { sheetsFetch, sheetsError } from './api.js';

// ─── Action Definitions ──────────────────────────────────────────────────────

const getSpreadsheet: ActionDefinition = {
  id: 'sheets.get_spreadsheet',
  name: 'Get Spreadsheet',
  description: 'Get spreadsheet metadata (title, sheets list, properties)',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID (from the URL)'),
  }),
};

const readRange: ActionDefinition = {
  id: 'sheets.read_range',
  name: 'Read Range',
  description: 'Read cell values from a range using A1 notation (e.g. Sheet1!A1:D10)',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range (e.g. "Sheet1!A1:D10")'),
    majorDimension: z.enum(['ROWS', 'COLUMNS']).optional().describe('Major dimension (default: ROWS)'),
    valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).optional()
      .describe('How values should be rendered (default: FORMATTED_VALUE)'),
  }),
};

const readMultipleRanges: ActionDefinition = {
  id: 'sheets.read_multiple_ranges',
  name: 'Read Multiple Ranges',
  description: 'Batch read multiple ranges in one call',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    ranges: z.array(z.string()).min(1).describe('Array of A1 notation ranges'),
    majorDimension: z.enum(['ROWS', 'COLUMNS']).optional(),
    valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).optional(),
  }),
};

const writeRange: ActionDefinition = {
  id: 'sheets.write_range',
  name: 'Write Range',
  description: 'Write values to a range using A1 notation',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range (e.g. "Sheet1!A1:D3")'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values (rows × columns)'),
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional()
      .describe('How input should be interpreted (default: USER_ENTERED, which parses formulas)'),
  }),
};

const appendRows: ActionDefinition = {
  id: 'sheets.append_rows',
  name: 'Append Rows',
  description: 'Append rows after the last row with data in a range',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range to search for data (e.g. "Sheet1!A:D")'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of rows to append'),
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional()
      .describe('How input should be interpreted (default: USER_ENTERED)'),
  }),
};

const clearRange: ActionDefinition = {
  id: 'sheets.clear_range',
  name: 'Clear Range',
  description: 'Clear all values from a range (formatting is preserved)',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range to clear'),
  }),
};

const createSpreadsheet: ActionDefinition = {
  id: 'sheets.create_spreadsheet',
  name: 'Create Spreadsheet',
  description: 'Create a new spreadsheet',
  riskLevel: 'medium',
  params: z.object({
    title: z.string().describe('Title of the new spreadsheet'),
    sheetTitles: z.array(z.string()).optional().describe('Names for the initial sheets (default: one sheet named "Sheet1")'),
  }),
};

const addSheet: ActionDefinition = {
  id: 'sheets.add_sheet',
  name: 'Add Sheet',
  description: 'Add a new sheet/tab to an existing spreadsheet',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    title: z.string().describe('Title for the new sheet'),
  }),
};

const deleteSheet: ActionDefinition = {
  id: 'sheets.delete_sheet',
  name: 'Delete Sheet',
  description: 'Delete a sheet/tab from a spreadsheet by its sheet ID',
  riskLevel: 'high',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    sheetId: z.number().int().describe('The numeric sheet ID (from get_spreadsheet)'),
  }),
};

const allActions: ActionDefinition[] = [
  getSpreadsheet,
  readRange,
  readMultipleRanges,
  writeRange,
  appendRows,
  clearRange,
  createSpreadsheet,
  addSheet,
  deleteSheet,
];

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = ctx.credentials.access_token || '';
  if (!token) return { success: false, error: 'Missing access token' };

  try {
    switch (actionId) {
      case 'sheets.get_spreadsheet': {
        const { spreadsheetId } = getSpreadsheet.params.parse(params);
        const qs = new URLSearchParams({
          fields: 'spreadsheetId,properties,sheets.properties',
        });
        const res = await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}?${qs}`, token);
        if (!res.ok) return sheetsError(res);
        return { success: true, data: await res.json() };
      }

      case 'sheets.read_range': {
        const p = readRange.params.parse(params);
        const qs = new URLSearchParams();
        if (p.majorDimension) qs.set('majorDimension', p.majorDimension);
        if (p.valueRenderOption) qs.set('valueRenderOption', p.valueRenderOption);
        const qsStr = qs.toString() ? `?${qs}` : '';
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}/values/${p.range}${qsStr}`,
          token,
        );
        if (!res.ok) return sheetsError(res);
        const data = await res.json() as { range: string; majorDimension: string; values?: string[][] };
        return {
          success: true,
          data: {
            range: data.range,
            majorDimension: data.majorDimension,
            values: data.values || [],
          },
        };
      }

      case 'sheets.read_multiple_ranges': {
        const p = readMultipleRanges.params.parse(params);
        const qs = new URLSearchParams();
        for (const range of p.ranges) qs.append('ranges', range);
        if (p.majorDimension) qs.set('majorDimension', p.majorDimension);
        if (p.valueRenderOption) qs.set('valueRenderOption', p.valueRenderOption);
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}/values:batchGet?${qs}`,
          token,
        );
        if (!res.ok) return sheetsError(res);
        const data = await res.json() as {
          spreadsheetId: string;
          valueRanges: Array<{ range: string; majorDimension: string; values?: string[][] }>;
        };
        return {
          success: true,
          data: {
            spreadsheetId: data.spreadsheetId,
            valueRanges: (data.valueRanges || []).map((vr) => ({
              range: vr.range,
              majorDimension: vr.majorDimension,
              values: vr.values || [],
            })),
          },
        };
      }

      case 'sheets.write_range': {
        const p = writeRange.params.parse(params);
        const inputOption = p.valueInputOption || 'USER_ENTERED';
        const qs = new URLSearchParams({ valueInputOption: inputOption });
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}/values/${p.range}?${qs}`,
          token,
          {
            method: 'PUT',
            body: JSON.stringify({
              range: p.range,
              majorDimension: 'ROWS',
              values: p.values,
            }),
          },
        );
        if (!res.ok) return sheetsError(res);
        return { success: true, data: await res.json() };
      }

      case 'sheets.append_rows': {
        const p = appendRows.params.parse(params);
        const inputOption = p.valueInputOption || 'USER_ENTERED';
        const qs = new URLSearchParams({
          valueInputOption: inputOption,
          insertDataOption: 'INSERT_ROWS',
        });
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}/values/${p.range}:append?${qs}`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({
              majorDimension: 'ROWS',
              values: p.values,
            }),
          },
        );
        if (!res.ok) return sheetsError(res);
        return { success: true, data: await res.json() };
      }

      case 'sheets.clear_range': {
        const p = clearRange.params.parse(params);
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}/values/${p.range}:clear`,
          token,
          { method: 'POST', body: JSON.stringify({}) },
        );
        if (!res.ok) return sheetsError(res);
        return { success: true, data: await res.json() };
      }

      case 'sheets.create_spreadsheet': {
        const p = createSpreadsheet.params.parse(params);
        const body: Record<string, unknown> = {
          properties: { title: p.title },
        };
        if (p.sheetTitles?.length) {
          body.sheets = p.sheetTitles.map((title: string) => ({
            properties: { title },
          }));
        }
        const res = await sheetsFetch('', token, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) return sheetsError(res);
        return { success: true, data: await res.json() };
      }

      case 'sheets.add_sheet': {
        const p = addSheet.params.parse(params);
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}:batchUpdate`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({
              requests: [{ addSheet: { properties: { title: p.title } } }],
            }),
          },
        );
        if (!res.ok) return sheetsError(res);
        const data = await res.json() as { replies: Array<{ addSheet: { properties: unknown } }> };
        return { success: true, data: data.replies?.[0]?.addSheet?.properties };
      }

      case 'sheets.delete_sheet': {
        const p = deleteSheet.params.parse(params);
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}:batchUpdate`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({
              requests: [{ deleteSheet: { sheetId: p.sheetId } }],
            }),
          },
        );
        if (!res.ok) return sheetsError(res);
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const googleSheetsActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
