import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { sheetsFetch, sheetsError } from './api.js';
import { cellFormatSchema, mergeSchema, normalizeFormatsResponse, parseA1Range, buildRepeatCellRequest, buildUpdateCellsRequest, buildMergeRequests } from './formatting.js';
import type { CellFormat } from './formatting.js';

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
  description: 'Write values to a range using A1 notation. Optionally include formatting to style cells in the same call.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range (e.g. "Sheet1!A1:D3")'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values (rows × columns)'),
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional()
      .describe('How input should be interpreted (default: USER_ENTERED). Ignored when formatting is provided.'),
    format: cellFormatSchema.optional().describe('Single format applied to all written cells'),
    formats: z.array(z.array(cellFormatSchema)).optional().describe('Per-cell formatting (must match values dimensions)'),
  }),
};

const appendRows: ActionDefinition = {
  id: 'sheets.append_rows',
  name: 'Append Rows',
  description: 'Append rows after the last row with data in a range. Optionally include formatting to style the appended rows.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range to search for data (e.g. "Sheet1!A:D")'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of rows to append'),
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional()
      .describe('How input should be interpreted (default: USER_ENTERED). Ignored when formatting is provided.'),
    format: cellFormatSchema.optional().describe('Single format applied to all appended cells'),
    formats: z.array(z.array(cellFormatSchema)).optional().describe('Per-cell formatting (must match values dimensions)'),
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

const readFormatting: ActionDefinition = {
  id: 'sheets.read_formatting',
  name: 'Read Formatting',
  description: 'Read cell formatting (colors, bold, borders, alignment, etc.) from a range. Use this to inspect existing styles before writing data so you can match them.',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range to inspect (e.g. "Sheet1!A1:F10")'),
  }),
};

const formatCells: ActionDefinition = {
  id: 'sheets.format_cells',
  name: 'Format Cells',
  description: 'Apply formatting (colors, bold, borders, alignment, number format, etc.) to a range. Use "format" for uniform styling or "formats" for per-cell styling. Can also merge/unmerge cells.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range to format (e.g. "Sheet1!A1:F10")'),
    format: cellFormatSchema.optional().describe('Single format applied to all cells in the range'),
    formats: z.array(z.array(cellFormatSchema)).optional().describe('Per-cell formatting grid (must match range dimensions)'),
    merges: z.array(mergeSchema).optional().describe('Merge regions to apply (0-based row/column indices)'),
    unmerge: z.boolean().optional().describe('If true, unmerge all cells in range before applying new merges'),
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
  readFormatting,
  formatCells,
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveSheetId(spreadsheetId: string, range: string, token: string): Promise<number> {
  const bangIndex = range.indexOf('!');
  let sheetName = bangIndex !== -1 ? range.slice(0, bangIndex).replace(/^'|'$/g, '') : '';

  const qs = new URLSearchParams({ fields: 'sheets.properties.sheetId,sheets.properties.title' });
  const res = await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}?${qs}`, token);
  if (!res.ok) return 0;
  const data = await res.json() as { sheets: Array<{ properties: { sheetId: number; title: string } }> };

  if (!sheetName) return data.sheets[0]?.properties?.sheetId ?? 0;
  const sheet = data.sheets.find((s) => s.properties.title === sheetName);
  return sheet?.properties?.sheetId ?? 0;
}

async function findNextEmptyRow(spreadsheetId: string, range: string, token: string): Promise<number> {
  const res = await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}/values/${range}`, token);
  if (!res.ok) return 0;
  const data = await res.json() as { values?: unknown[][] };
  return data.values?.length ?? 0;
}

function columnLetterToIndex(col: string): number {
  let index = 0;
  for (let i = 0; i < col.length; i++) {
    index = index * 26 + (col.charCodeAt(i) - 64);
  }
  return index - 1;
}

function extractStartColumnIndex(range: string): number {
  let rangeOnly = range;
  const bangIndex = range.indexOf('!');
  if (bangIndex !== -1) {
    rangeOnly = range.slice(bangIndex + 1);
  }
  const colMatch = rangeOnly.match(/^([A-Z]+)/);
  return colMatch ? columnLetterToIndex(colMatch[1]) : 0;
}

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

        if (p.format || p.formats) {
          const sheetId = await resolveSheetId(p.spreadsheetId, p.range, token);
          const gridRange = parseA1Range(p.range, sheetId);

          let cellFormats: CellFormat[][];
          if (p.formats) {
            cellFormats = p.formats;
          } else {
            cellFormats = p.values.map((row: unknown[]) => row.map(() => p.format!));
          }

          const request = buildUpdateCellsRequest(gridRange, cellFormats, p.values);
          const res = await sheetsFetch(
            `/${encodeURIComponent(p.spreadsheetId)}:batchUpdate`,
            token,
            { method: 'POST', body: JSON.stringify({ requests: [request] }) },
          );
          if (!res.ok) return sheetsError(res);
          return { success: true, data: await res.json() };
        }

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

        if (p.format || p.formats) {
          const sheetId = await resolveSheetId(p.spreadsheetId, p.range, token);
          const nextRow = await findNextEmptyRow(p.spreadsheetId, p.range, token);

          const startColIndex = extractStartColumnIndex(p.range);
          const startRange = {
            sheetId,
            startRowIndex: nextRow,
            endRowIndex: nextRow + p.values.length,
            startColumnIndex: startColIndex,
            endColumnIndex: startColIndex + (p.values[0]?.length ?? 0),
          };

          let cellFormats: CellFormat[][];
          if (p.formats) {
            cellFormats = p.formats;
          } else {
            cellFormats = p.values.map((row: unknown[]) => row.map(() => p.format!));
          }

          const request = buildUpdateCellsRequest(startRange, cellFormats, p.values);
          const res = await sheetsFetch(
            `/${encodeURIComponent(p.spreadsheetId)}:batchUpdate`,
            token,
            { method: 'POST', body: JSON.stringify({ requests: [request] }) },
          );
          if (!res.ok) return sheetsError(res);
          return { success: true, data: await res.json() };
        }

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

      case 'sheets.read_formatting': {
        const p = readFormatting.params.parse(params);
        const fields = [
          'sheets.properties.sheetId',
          'sheets.properties.title',
          'sheets.data.rowData.values.userEnteredFormat',
          'sheets.merges',
        ].join(',');
        const qs = new URLSearchParams({ ranges: p.range, fields });
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}?${qs}`,
          token,
        );
        if (!res.ok) return sheetsError(res);
        const data = await res.json();
        return { success: true, data: normalizeFormatsResponse(data, p.range) };
      }

      case 'sheets.format_cells': {
        const p = formatCells.params.parse(params);
        if (!p.format && !p.formats && !p.merges) {
          return { success: false, error: 'At least one of format, formats, or merges must be provided' };
        }

        const sheetId = await resolveSheetId(p.spreadsheetId, p.range, token);
        const gridRange = parseA1Range(p.range, sheetId);

        const requests: Array<Record<string, unknown>> = [];

        if (p.format) {
          requests.push(buildRepeatCellRequest(gridRange, p.format));
        } else if (p.formats) {
          requests.push(buildUpdateCellsRequest(gridRange, p.formats));
        }

        if (p.merges) {
          requests.push(...buildMergeRequests(p.merges, p.unmerge ?? false));
        }

        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}:batchUpdate`,
          token,
          { method: 'POST', body: JSON.stringify({ requests }) },
        );
        if (!res.ok) return sheetsError(res);

        return {
          success: true,
          data: { updatedRange: p.range, mergesApplied: p.merges?.length ?? 0 },
        };
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
