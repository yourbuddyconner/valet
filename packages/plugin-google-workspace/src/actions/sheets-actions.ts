import { z } from 'zod';
import type { ActionDefinition, ActionContext, ActionResult } from '@valet/sdk';
import {
  sheetsFetch,
  sheetsError,
  resolveSheetId,
  parseRange,
  parseA1ToGridRange,
  colLettersToIndex,
  colIndexToLetters,
  rowColToA1,
  hexToRgb,
  rgbToHex,
  normalizeColor,
  sheetsBatchUpdate,
  readRange,
  writeRange,
  appendValues,
  clearRange,
  getSpreadsheetMetadata,
  formatCells,
  freezeRowsAndColumns,
  setColumnWidths,
  setDropdownValidation,
  addConditionalFormatRule,
  resolveTableIdentifier,
  listAllTables,
} from './sheets-helpers.js';
import { withGoogleWorkspaceOutputSchemas } from './workspace-output-schemas.js';

// ─── Shared Schemas ───────────────────────────────────────────────────────

/** Color input: accepts hex string "#FF0000" or RGB object {red, green, blue} with 0-1 values. */
const colorInput = z.union([
  z.string().describe('Hex color string, e.g. "#FF0000"'),
  z.object({ red: z.number(), green: z.number(), blue: z.number() }).describe('RGB object with 0-1 values'),
]);

// ─── Action Definitions ────────────────────────────────────────────────────

// -- Core Data (8) -----------------------------------------------------------

const readSpreadsheet: ActionDefinition = {
  id: 'sheets.read_spreadsheet',
  name: 'Read Spreadsheet',
  description: 'Read data from a range in a spreadsheet. Returns rows as arrays.',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range (e.g. "Sheet1!A1:D10")'),
    valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).optional()
      .describe('How values should be rendered (default: FORMATTED_VALUE)'),
  }),
};

const writeSpreadsheet: ActionDefinition = {
  id: 'sheets.write_spreadsheet',
  name: 'Write Spreadsheet',
  description: 'Write data to a range, overwriting existing values. Use append_rows to add without overwriting.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range'),
    data: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values'),
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional()
      .describe('How input should be interpreted (default: USER_ENTERED)'),
  }),
};

const appendRowsDef: ActionDefinition = {
  id: 'sheets.append_rows',
  name: 'Append Rows',
  description: 'Append rows after the last row with data in a range.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range to search for data'),
    data: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of rows'),
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional()
      .describe('How input should be interpreted (default: USER_ENTERED)'),
  }),
};

const createSpreadsheet: ActionDefinition = {
  id: 'sheets.create_spreadsheet',
  name: 'Create Spreadsheet',
  description: 'Create a new spreadsheet with a title and optional sheet names.',
  riskLevel: 'medium',
  params: z.object({
    title: z.string().describe('Spreadsheet title'),
    sheetTitles: z.array(z.string()).optional().describe('Initial sheet names'),
  }),
};

const getSpreadsheetInfo: ActionDefinition = {
  id: 'sheets.get_spreadsheet_info',
  name: 'Get Spreadsheet Info',
  description: 'Get spreadsheet metadata including title, URL, and a list of all sheets with dimensions.',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
  }),
};

const listSpreadsheets: ActionDefinition = {
  id: 'sheets.list_spreadsheets',
  name: 'List Spreadsheets',
  description: 'List spreadsheets in your Drive, optionally filtered by name.',
  riskLevel: 'low',
  params: z.object({
    query: z.string().optional().describe('Search text'),
    maxResults: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
  }),
};

const batchWrite: ActionDefinition = {
  id: 'sheets.batch_write',
  name: 'Batch Write',
  description: 'Write data to multiple ranges in a single API call.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    data: z.array(z.object({
      range: z.string().describe('A1 notation range'),
      values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
    })).min(1).describe('Array of range+values pairs'),
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional()
      .describe('How input should be interpreted (default: USER_ENTERED)'),
  }),
};

const clearRangeDef: ActionDefinition = {
  id: 'sheets.clear_range',
  name: 'Clear Range',
  description: 'Clear all values from a range (formatting is preserved).',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range to clear'),
  }),
};

// -- Sheet Management (5) ----------------------------------------------------

const addSheet: ActionDefinition = {
  id: 'sheets.add_sheet',
  name: 'Add Sheet',
  description: 'Add a new sheet/tab to an existing spreadsheet.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    title: z.string().describe('Sheet/tab title'),
  }),
};

const deleteSheet: ActionDefinition = {
  id: 'sheets.delete_sheet',
  name: 'Delete Sheet',
  description: 'Delete a sheet/tab from a spreadsheet by its numeric sheet ID.',
  riskLevel: 'high',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetId: z.number().int().describe('Numeric sheet ID (from get_spreadsheet_info)'),
  }),
};

const renameSheet: ActionDefinition = {
  id: 'sheets.rename_sheet',
  name: 'Rename Sheet',
  description: 'Rename a sheet/tab in a spreadsheet.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetId: z.number().int().describe('Numeric sheet ID'),
    title: z.string().describe('New sheet title'),
  }),
};

const duplicateSheet: ActionDefinition = {
  id: 'sheets.duplicate_sheet',
  name: 'Duplicate Sheet',
  description: 'Duplicate a sheet/tab within a spreadsheet, copying all values, formulas, formatting, and validations.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetId: z.number().int().describe('Sheet ID to duplicate'),
    title: z.string().optional().describe('Title for the copy'),
  }),
};

const copySheetTo: ActionDefinition = {
  id: 'sheets.copy_sheet_to',
  name: 'Copy Sheet To',
  description: 'Copy a sheet/tab from one spreadsheet to another.',
  riskLevel: 'medium',
  params: z.object({
    sourceSpreadsheetId: z.string().describe('Source spreadsheet ID'),
    sheetId: z.number().int().describe('Sheet ID to copy'),
    destinationSpreadsheetId: z.string().describe('Target spreadsheet ID'),
  }),
};

// -- Cell Formatting (9) -----------------------------------------------------

const formatCellsDef: ActionDefinition = {
  id: 'sheets.format_cells',
  name: 'Format Cells',
  description: 'Apply formatting to a range. Supports bold, italic, font size, colors, alignment, number format, and wrap strategy. Text properties (bold, italic, fontSize, foregroundColor) can be passed at the top level or nested under textFormat.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range'),
    format: z.object({
      backgroundColor: colorInput.optional(),
      // Top-level shortcuts for text formatting (auto-nested into textFormat)
      bold: z.boolean().optional().describe('Shortcut: equivalent to textFormat.bold'),
      italic: z.boolean().optional().describe('Shortcut: equivalent to textFormat.italic'),
      fontSize: z.number().optional().describe('Shortcut: equivalent to textFormat.fontSize'),
      foregroundColor: colorInput.optional().describe('Shortcut: equivalent to textFormat.foregroundColor'),
      // Nested form still supported
      textFormat: z.object({
        foregroundColor: colorInput.optional(),
        fontSize: z.number().optional(),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
      }).optional(),
      horizontalAlignment: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(),
      verticalAlignment: z.enum(['TOP', 'MIDDLE', 'BOTTOM']).optional(),
      wrapStrategy: z.enum(['OVERFLOW_CELL', 'CLIP', 'WRAP']).optional(),
      numberFormat: z.object({ type: z.string(), pattern: z.string().optional() }).optional(),
    }).describe('Cell formatting properties'),
  }),
};

const readCellFormat: ActionDefinition = {
  id: 'sheets.read_cell_format',
  name: 'Read Cell Format',
  description: 'Read formatting/style of cells in a range (bold, colors, borders, alignment, number format).',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range'),
  }),
};

const copyFormatting: ActionDefinition = {
  id: 'sheets.copy_formatting',
  name: 'Copy Formatting',
  description: 'Copy formatting (not values) from a source range to a destination range within the same spreadsheet.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sourceRange: z.string().describe('A1 notation source range (including sheet name)'),
    destinationRange: z.string().describe('A1 notation destination range (including sheet name)'),
  }),
};

const setColumnWidthsDef: ActionDefinition = {
  id: 'sheets.set_column_widths',
  name: 'Set Column Widths',
  description: 'Set the width (in pixels) of one or more columns.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name (default: first sheet)'),
    columnWidths: z.array(z.object({
      column: z.string().describe('Column letter(s) or range, e.g. "A" or "A:C"'),
      width: z.number().describe('Width in pixels'),
    })).min(1),
  }),
};

const setRowHeights: ActionDefinition = {
  id: 'sheets.set_row_heights',
  name: 'Set Row Heights',
  description: 'Set a fixed pixel height for a range of rows.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name (default: first sheet)'),
    rowHeights: z.array(z.object({
      startRow: z.number().int().describe('Start row (1-based)'),
      endRow: z.number().int().describe('End row (1-based, inclusive)'),
      height: z.number().describe('Height in pixels'),
    })).min(1),
  }),
};

const autoResizeColumns: ActionDefinition = {
  id: 'sheets.auto_resize_columns',
  name: 'Auto Resize Columns',
  description: 'Auto-resize columns to fit their content.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name'),
    startColumn: z.string().describe('Start column letter, e.g. "A"'),
    endColumn: z.string().describe('End column letter, e.g. "D"'),
  }),
};

const autoResizeRows: ActionDefinition = {
  id: 'sheets.auto_resize_rows',
  name: 'Auto Resize Rows',
  description: 'Auto-resize rows to fit their content.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name'),
    startRow: z.number().int().describe('Start row (1-based)'),
    endRow: z.number().int().describe('End row (1-based, inclusive)'),
  }),
};

const setCellBorders: ActionDefinition = {
  id: 'sheets.set_cell_borders',
  name: 'Set Cell Borders',
  description: 'Set borders on a range of cells. Each side can be configured independently.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range'),
    borders: z.object({
      top: z.object({ style: z.string(), color: colorInput.optional() }).optional(),
      bottom: z.object({ style: z.string(), color: colorInput.optional() }).optional(),
      left: z.object({ style: z.string(), color: colorInput.optional() }).optional(),
      right: z.object({ style: z.string(), color: colorInput.optional() }).optional(),
      innerHorizontal: z.object({ style: z.string(), color: colorInput.optional() }).optional(),
      innerVertical: z.object({ style: z.string(), color: colorInput.optional() }).optional(),
    }).describe('Border styles (style: DOTTED, DASHED, SOLID, SOLID_MEDIUM, SOLID_THICK, DOUBLE, NONE)'),
  }),
};

const freezeRowsAndColumnsDef: ActionDefinition = {
  id: 'sheets.freeze_rows_and_columns',
  name: 'Freeze Rows and Columns',
  description: 'Pin rows and/or columns so they stay visible when scrolling.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name'),
    frozenRowCount: z.number().int().min(0).optional().describe('Number of rows to freeze'),
    frozenColumnCount: z.number().int().min(0).optional().describe('Number of columns to freeze'),
  }),
};

// -- Tables (6) --------------------------------------------------------------

const createTable: ActionDefinition = {
  id: 'sheets.create_table',
  name: 'Create Table',
  description: 'Create a new named table with structured columns and optional column types.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name (default: first sheet)'),
    name: z.string().describe('Table name'),
    range: z.string().describe('A1 notation range for the table'),
    columns: z.array(z.string()).optional().describe('Column header names'),
  }),
};

const getTable: ActionDefinition = {
  id: 'sheets.get_table',
  name: 'Get Table',
  description: 'Get detailed information about a specific table including its columns, range, and properties.',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    tableIdentifier: z.string().describe('Table ID or name'),
  }),
};

const listTablesDef: ActionDefinition = {
  id: 'sheets.list_tables',
  name: 'List Tables',
  description: 'List all tables in a spreadsheet, optionally filtered by sheet.',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Filter by sheet name'),
  }),
};

const deleteTable: ActionDefinition = {
  id: 'sheets.delete_table',
  name: 'Delete Table',
  description: 'Delete a table from a spreadsheet (table object removed; data preserved unless deleteData is true).',
  riskLevel: 'high',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    tableId: z.string().describe('Table ID'),
    deleteData: z.boolean().optional().describe('Also clear cell data in the table range (default: false)'),
  }),
};

const updateTableRange: ActionDefinition = {
  id: 'sheets.update_table_range',
  name: 'Update Table Range',
  description: "Modify a table's dimensions by updating its range.",
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    tableId: z.string().describe('Table ID'),
    range: z.string().describe('New A1 notation range for the table'),
  }),
};

const appendTableRows: ActionDefinition = {
  id: 'sheets.append_table_rows',
  name: 'Append Table Rows',
  description: 'Append rows to the end of a table using table-aware insertion.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    tableId: z.string().describe('Table ID'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of row values'),
  }),
};

// -- Advanced (9) ------------------------------------------------------------

const groupRows: ActionDefinition = {
  id: 'sheets.group_rows',
  name: 'Group Rows',
  description: 'Create collapsible row groups.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name'),
    startRow: z.number().int().min(1).describe('Start row (1-based)'),
    endRow: z.number().int().min(1).describe('End row (1-based, inclusive)'),
  }),
};

const ungroupAllRows: ActionDefinition = {
  id: 'sheets.ungroup_all_rows',
  name: 'Ungroup All Rows',
  description: 'Remove all row groupings from a sheet.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name'),
  }),
};

const insertChart: ActionDefinition = {
  id: 'sheets.insert_chart',
  name: 'Insert Chart',
  description: 'Insert a chart into a Google Sheet. Supports bar, column, line, area, scatter, combo, and pie chart types.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name'),
    chartType: z.enum(['BAR', 'LINE', 'AREA', 'COLUMN', 'SCATTER', 'COMBO', 'PIE']).describe('Chart type'),
    sourceRange: z.string().describe('A1 notation data range'),
    title: z.string().optional().describe('Chart title'),
    position: z.object({
      anchorCell: z.string().optional().describe('A1 notation anchor cell for chart placement (e.g. "A15")'),
      rowIndex: z.number().int().min(0).optional().describe('0-based row index for chart placement (alternative to anchorCell)'),
      columnIndex: z.number().int().min(0).optional().describe('0-based column index for chart placement (alternative to anchorCell)'),
    }).optional(),
  }),
};

const deleteChart: ActionDefinition = {
  id: 'sheets.delete_chart',
  name: 'Delete Chart',
  description: 'Delete a chart from a spreadsheet by its chart ID.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    chartId: z.number().int().describe('Chart ID (from get_spreadsheet_info)'),
  }),
};

const addConditionalFormatting: ActionDefinition = {
  id: 'sheets.add_conditional_formatting',
  name: 'Add Conditional Formatting',
  description: 'Add a conditional formatting rule to one or more ranges. Use CUSTOM_FORMULA for complex conditions.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range'),
    conditionType: z.string().describe('Condition type (e.g. NUMBER_GREATER, TEXT_CONTAINS, CUSTOM_FORMULA, BLANK, NOT_BLANK)'),
    conditionValues: z.array(z.string()).describe('Condition values'),
    format: z.object({
      backgroundColor: colorInput.optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      textFormat: z.object({
        foregroundColor: colorInput.optional(),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
      }).optional(),
    }).describe('Format to apply when condition is met'),
  }),
};

const deleteConditionalFormatting: ActionDefinition = {
  id: 'sheets.delete_conditional_formatting',
  name: 'Delete Conditional Formatting',
  description: 'Delete a conditional formatting rule by its index.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetId: z.number().int().describe('Sheet ID'),
    index: z.number().int().min(0).describe('Rule index (0-based, from get_conditional_formatting)'),
  }),
};

const getConditionalFormatting: ActionDefinition = {
  id: 'sheets.get_conditional_formatting',
  name: 'Get Conditional Formatting',
  description: 'List all conditional formatting rules for a sheet.',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    sheetName: z.string().optional().describe('Sheet name'),
  }),
};

const setDropdownValidationDef: ActionDefinition = {
  id: 'sheets.set_dropdown_validation',
  name: 'Set Dropdown Validation',
  description: 'Add or remove a dropdown list on a range of cells.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range'),
    values: z.array(z.string()).optional().describe('Dropdown values (omit to clear)'),
    strict: z.boolean().optional().describe('Reject invalid input (default: true)'),
    inputMessage: z.string().optional().describe('Help text shown on cell selection'),
  }),
};

const protectRange: ActionDefinition = {
  id: 'sheets.protect_range',
  name: 'Protect Range',
  description: 'Lock a range or entire sheet to prevent accidental edits.',
  riskLevel: 'medium',
  params: z.object({
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range to protect'),
    description: z.string().optional().describe('Protection description'),
    warningOnly: z.boolean().optional().describe('Show warning instead of blocking (default: false)'),
  }),
};

// ─── All Actions ───────────────────────────────────────────────────────────

const allActions: ActionDefinition[] = [
  // Core data
  readSpreadsheet,
  writeSpreadsheet,
  appendRowsDef,
  createSpreadsheet,
  getSpreadsheetInfo,
  listSpreadsheets,
  batchWrite,
  clearRangeDef,
  // Sheet management
  addSheet,
  deleteSheet,
  renameSheet,
  duplicateSheet,
  copySheetTo,
  // Cell formatting
  formatCellsDef,
  readCellFormat,
  copyFormatting,
  setColumnWidthsDef,
  setRowHeights,
  autoResizeColumns,
  autoResizeRows,
  setCellBorders,
  freezeRowsAndColumnsDef,
  // Tables
  createTable,
  getTable,
  listTablesDef,
  deleteTable,
  updateTableRange,
  appendTableRows,
  // Advanced
  groupRows,
  ungroupAllRows,
  insertChart,
  deleteChart,
  addConditionalFormatting,
  deleteConditionalFormatting,
  getConditionalFormatting,
  setDropdownValidationDef,
  protectRange,
];

// ─── Helpers for readCellFormat simplification ─────────────────────────────

function simplifyFormat(fmt: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!fmt) return null;
  const result: Record<string, unknown> = {};

  if (fmt.textFormat) {
    const tf = fmt.textFormat as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (tf.bold) out.bold = true;
    if (tf.italic) out.italic = true;
    if (tf.strikethrough) out.strikethrough = true;
    if (tf.underline) out.underline = true;
    if (tf.fontSize != null) out.fontSize = tf.fontSize;
    if (tf.fontFamily) out.fontFamily = tf.fontFamily;
    const fgStyle = tf.foregroundColorStyle as { rgbColor?: Record<string, number> } | undefined;
    if (fgStyle?.rgbColor) {
      out.foregroundColor = rgbToHex(fgStyle.rgbColor);
    } else if (tf.foregroundColor) {
      out.foregroundColor = rgbToHex(tf.foregroundColor as Record<string, number>);
    }
    if (Object.keys(out).length > 0) result.textFormat = out;
  }

  const bgStyle = (fmt.backgroundColorStyle as { rgbColor?: Record<string, number> }) || undefined;
  if (bgStyle?.rgbColor) {
    result.backgroundColor = rgbToHex(bgStyle.rgbColor);
  } else if (fmt.backgroundColor) {
    result.backgroundColor = rgbToHex(fmt.backgroundColor as Record<string, number>);
  }

  if (fmt.horizontalAlignment) result.horizontalAlignment = fmt.horizontalAlignment;
  if (fmt.verticalAlignment) result.verticalAlignment = fmt.verticalAlignment;
  if (fmt.numberFormat) result.numberFormat = fmt.numberFormat;

  if (fmt.borders) {
    const borders: Record<string, unknown> = {};
    const b = fmt.borders as Record<string, Record<string, unknown>>;
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      if (b[side]) {
        const sideObj: Record<string, unknown> = { style: b[side].style };
        const cs = b[side].colorStyle as { rgbColor?: Record<string, number> } | undefined;
        if (cs?.rgbColor) {
          sideObj.color = rgbToHex(cs.rgbColor);
        } else if (b[side].color) {
          sideObj.color = rgbToHex(b[side].color as Record<string, number>);
        }
        borders[side] = sideObj;
      }
    }
    if (Object.keys(borders).length > 0) result.borders = borders;
  }

  if (fmt.wrapStrategy) result.wrapStrategy = fmt.wrapStrategy;

  return Object.keys(result).length > 0 ? result : null;
}

// ─── Action Execution ──────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = ctx.credentials.access_token || '';
  if (!token) return { success: false, error: 'Missing access token' };

  try {
    switch (actionId) {
      // ── Core Data ──────────────────────────────────────────────────────

      case 'sheets.read_spreadsheet': {
        const p = readSpreadsheet.params.parse(params);
        const data = await readRange(token, p.spreadsheetId, p.range, p.valueRenderOption);
        return { success: true, data };
      }

      case 'sheets.write_spreadsheet': {
        const p = writeSpreadsheet.params.parse(params);
        const data = await writeRange(
          token,
          p.spreadsheetId,
          p.range,
          p.data,
          p.valueInputOption,
        );
        return { success: true, data };
      }

      case 'sheets.append_rows': {
        const p = appendRowsDef.params.parse(params);
        const data = await appendValues(
          token,
          p.spreadsheetId,
          p.range,
          p.data,
          p.valueInputOption,
        );
        return { success: true, data };
      }

      case 'sheets.create_spreadsheet': {
        const p = createSpreadsheet.params.parse(params);
        const body: Record<string, unknown> = {
          properties: { title: p.title },
        };
        if (p.sheetTitles?.length) {
          body.sheets = p.sheetTitles.map((t: string) => ({ properties: { title: t } }));
        }
        const res = await sheetsFetch('', token, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) return sheetsError(res);
        return { success: true, data: await res.json() };
      }

      case 'sheets.get_spreadsheet_info': {
        const p = getSpreadsheetInfo.params.parse(params);
        const qs = new URLSearchParams({
          fields: 'spreadsheetId,properties,sheets.properties',
        });
        const res = await sheetsFetch(`/${encodeURIComponent(p.spreadsheetId)}?${qs}`, token);
        if (!res.ok) return sheetsError(res);
        const data = await res.json() as {
          spreadsheetId: string;
          properties: { title: string };
          sheets: Array<{
            properties: {
              title: string;
              sheetId: number;
              gridProperties?: { rowCount: number; columnCount: number };
              hidden?: boolean;
            };
          }>;
        };
        return {
          success: true,
          data: {
            title: data.properties?.title || 'Untitled',
            spreadsheetId: data.spreadsheetId,
            url: `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}`,
            sheets: (data.sheets || []).map((s) => ({
              title: s.properties?.title,
              sheetId: s.properties?.sheetId,
              rows: s.properties?.gridProperties?.rowCount || 0,
              columns: s.properties?.gridProperties?.columnCount || 0,
              hidden: s.properties?.hidden || false,
            })),
          },
        };
      }

      case 'sheets.list_spreadsheets': {
        const p = listSpreadsheets.params.parse(params);
        const labelFilter = (params as Record<string, unknown>).__labelFilter as string | undefined;
        const queryParts: string[] = [
          "mimeType='application/vnd.google-apps.spreadsheet'",
          'trashed=false',
        ];
        if (p.query) {
          queryParts.push(`fullText contains '${p.query.replace(/'/g, "\\'")}'`);
        }
        const userQuery = queryParts.join(' and ');
        let finalQuery: string;
        if (userQuery && labelFilter) {
          finalQuery = `(${userQuery}) and ${labelFilter}`;
        } else if (labelFilter) {
          finalQuery = labelFilter;
        } else {
          finalQuery = userQuery;
        }
        const qs = new URLSearchParams({
          q: finalQuery,
          fields: 'files(id,name,modifiedTime,webViewLink)',
          pageSize: String(p.maxResults || 20),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?${qs}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => res.statusText);
          return { success: false, error: `Drive API ${res.status}: ${detail}` };
        }
        const data = await res.json() as {
          files: Array<{ id: string; name: string; modifiedTime: string; webViewLink: string }>;
        };
        return {
          success: true,
          data: {
            spreadsheets: (data.files || []).map((f) => ({
              id: f.id,
              name: f.name,
              modifiedTime: f.modifiedTime,
              url: f.webViewLink,
            })),
          },
        };
      }

      case 'sheets.batch_write': {
        const p = batchWrite.params.parse(params);
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}/values:batchUpdate`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({
              valueInputOption: p.valueInputOption || 'USER_ENTERED',
              data: p.data.map((d: { range: string; values: unknown[][] }) => ({ range: d.range, values: d.values })),
            }),
          },
        );
        if (!res.ok) return sheetsError(res);
        return { success: true, data: await res.json() };
      }

      case 'sheets.clear_range': {
        const p = clearRangeDef.params.parse(params);
        const data = await clearRange(token, p.spreadsheetId, p.range);
        return { success: true, data };
      }

      // ── Sheet Management ───────────────────────────────────────────────

      case 'sheets.add_sheet': {
        const p = addSheet.params.parse(params);
        const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
          { addSheet: { properties: { title: p.title } } },
        ]);
        const replies = (data as { replies?: Array<{ addSheet?: { properties?: unknown } }> }).replies;
        return { success: true, data: replies?.[0]?.addSheet?.properties };
      }

      case 'sheets.delete_sheet': {
        const p = deleteSheet.params.parse(params);
        await sheetsBatchUpdate(token, p.spreadsheetId, [
          { deleteSheet: { sheetId: p.sheetId } },
        ]);
        return { success: true };
      }

      case 'sheets.rename_sheet': {
        const p = renameSheet.params.parse(params);
        await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            updateSheetProperties: {
              properties: { sheetId: p.sheetId, title: p.title },
              fields: 'title',
            },
          },
        ]);
        return { success: true, data: { sheetId: p.sheetId, title: p.title } };
      }

      case 'sheets.duplicate_sheet': {
        const p = duplicateSheet.params.parse(params);
        const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            duplicateSheet: {
              sourceSheetId: p.sheetId,
              ...(p.title ? { newSheetName: p.title } : {}),
            },
          },
        ]);
        const replies = (data as { replies?: Array<{ duplicateSheet?: { properties?: unknown } }> }).replies;
        return { success: true, data: replies?.[0]?.duplicateSheet?.properties };
      }

      case 'sheets.copy_sheet_to': {
        const p = copySheetTo.params.parse(params);
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.sourceSpreadsheetId)}/sheets/${p.sheetId}:copyTo`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({ destinationSpreadsheetId: p.destinationSpreadsheetId }),
          },
        );
        if (!res.ok) return sheetsError(res);
        return { success: true, data: await res.json() };
      }

      // ── Cell Formatting ────────────────────────────────────────────────

      case 'sheets.format_cells': {
        const p = formatCellsDef.params.parse(params);
        const fmt = p.format;

        // Merge top-level text shortcuts into textFormat
        const mergedTextFormat = { ...fmt.textFormat };
        if (fmt.bold !== undefined && mergedTextFormat.bold === undefined) mergedTextFormat.bold = fmt.bold;
        if (fmt.italic !== undefined && mergedTextFormat.italic === undefined) mergedTextFormat.italic = fmt.italic;
        if (fmt.fontSize !== undefined && mergedTextFormat.fontSize === undefined) mergedTextFormat.fontSize = fmt.fontSize;
        if (fmt.foregroundColor !== undefined && mergedTextFormat.foregroundColor === undefined) {
          mergedTextFormat.foregroundColor = fmt.foregroundColor;
        }
        const hasTextFormat = mergedTextFormat.bold !== undefined || mergedTextFormat.italic !== undefined
          || mergedTextFormat.fontSize !== undefined || mergedTextFormat.foregroundColor !== undefined;

        // Normalize colors (accept hex strings or RGB objects)
        const bgColor = fmt.backgroundColor ? normalizeColor(fmt.backgroundColor) : undefined;
        const fgColor = mergedTextFormat.foregroundColor ? normalizeColor(mergedTextFormat.foregroundColor) : undefined;

        await formatCells(token, p.spreadsheetId, p.range, {
          backgroundColor: bgColor ?? undefined,
          textFormat: hasTextFormat ? {
            bold: mergedTextFormat.bold,
            italic: mergedTextFormat.italic,
            fontSize: mergedTextFormat.fontSize,
            foregroundColor: fgColor ?? undefined,
          } : undefined,
          horizontalAlignment: fmt.horizontalAlignment,
          verticalAlignment: fmt.verticalAlignment,
          wrapStrategy: fmt.wrapStrategy,
          numberFormat: fmt.numberFormat,
        });
        return { success: true, data: { updatedRange: p.range } };
      }

      case 'sheets.read_cell_format': {
        const p = readCellFormat.params.parse(params);
        const fields = [
          'sheets.data.rowData.values.userEnteredFormat',
          'sheets.data.startRow',
          'sheets.data.startColumn',
        ].join(',');
        const qs = new URLSearchParams({
          ranges: p.range,
          includeGridData: 'true',
          fields,
        });
        const res = await sheetsFetch(
          `/${encodeURIComponent(p.spreadsheetId)}?${qs}`,
          token,
        );
        if (!res.ok) return sheetsError(res);

        const apiData = await res.json() as {
          sheets?: Array<{
            data?: Array<{
              startRow?: number;
              startColumn?: number;
              rowData?: Array<{
                values?: Array<{ userEnteredFormat?: Record<string, unknown> }>;
              }>;
            }>;
          }>;
        };

        const sheetData = apiData.sheets?.[0]?.data?.[0];
        if (!sheetData?.rowData) {
          return { success: true, data: { range: p.range, cells: [] } };
        }

        const startRow = sheetData.startRow ?? 0;
        const startCol = sheetData.startColumn ?? 0;
        const cells: Array<{ cell: string; format: Record<string, unknown> }> = [];

        for (let rowIdx = 0; rowIdx < sheetData.rowData.length; rowIdx++) {
          const row = sheetData.rowData[rowIdx];
          if (!row.values) continue;
          for (let colIdx = 0; colIdx < row.values.length; colIdx++) {
            const cellData = row.values[colIdx];
            const fmt = simplifyFormat(cellData?.userEnteredFormat);
            if (fmt) {
              cells.push({ cell: rowColToA1(startRow + rowIdx, startCol + colIdx), format: fmt });
            }
          }
        }

        return { success: true, data: { range: p.range, cells } };
      }

      case 'sheets.copy_formatting': {
        const p = copyFormatting.params.parse(params);
        const srcParsed = parseRange(p.sourceRange);
        const dstParsed = parseRange(p.destinationRange);
        const srcSheetId = await resolveSheetId(token, p.spreadsheetId, srcParsed.sheetName);
        const dstSheetId = await resolveSheetId(token, p.spreadsheetId, dstParsed.sheetName);
        const srcGrid = parseA1ToGridRange(srcParsed.a1Range, srcSheetId);
        const dstGrid = parseA1ToGridRange(dstParsed.a1Range, dstSheetId);

        await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            copyPaste: {
              source: srcGrid,
              destination: dstGrid,
              pasteType: 'PASTE_FORMAT',
            },
          },
        ]);
        return { success: true, data: { source: p.sourceRange, destination: p.destinationRange } };
      }

      case 'sheets.set_column_widths': {
        const p = setColumnWidthsDef.params.parse(params);
        await setColumnWidths(token, p.spreadsheetId, p.sheetName, p.columnWidths);
        return { success: true, data: { columnWidths: p.columnWidths } };
      }

      case 'sheets.set_row_heights': {
        const p = setRowHeights.params.parse(params);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
        const requests = p.rowHeights.map((rh: { startRow: number; endRow: number; height: number }) => ({
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rh.startRow - 1,
              endIndex: rh.endRow,
            },
            properties: { pixelSize: rh.height },
            fields: 'pixelSize',
          },
        }));
        await sheetsBatchUpdate(token, p.spreadsheetId, requests);
        return { success: true, data: { rowHeights: p.rowHeights } };
      }

      case 'sheets.auto_resize_columns': {
        const p = autoResizeColumns.params.parse(params);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
        const startIndex = colLettersToIndex(p.startColumn);
        const endIndex = colLettersToIndex(p.endColumn) + 1;

        await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: 'COLUMNS', startIndex, endIndex },
            },
          },
        ]);
        return { success: true, data: { columns: `${p.startColumn}:${p.endColumn}` } };
      }

      case 'sheets.auto_resize_rows': {
        const p = autoResizeRows.params.parse(params);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
        await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: 'ROWS',
                startIndex: p.startRow - 1,
                endIndex: p.endRow,
              },
            },
          },
        ]);
        return { success: true, data: { rows: `${p.startRow}:${p.endRow}` } };
      }

      case 'sheets.set_cell_borders': {
        const p = setCellBorders.params.parse(params);
        const { sheetName, a1Range } = parseRange(p.range);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName);
        const gridRange = parseA1ToGridRange(a1Range, sheetId);

        const buildBorder = (b: { style: string; color?: string | { red: number; green: number; blue: number } } | undefined) => {
          if (!b) return undefined;
          const border: Record<string, unknown> = { style: b.style };
          if (b.color) {
            const rgb = normalizeColor(b.color);
            if (rgb) border.colorStyle = { rgbColor: rgb };
          }
          return border;
        };

        const borders: Record<string, unknown> = {};
        if (p.borders.top !== undefined) borders.top = buildBorder(p.borders.top);
        if (p.borders.bottom !== undefined) borders.bottom = buildBorder(p.borders.bottom);
        if (p.borders.left !== undefined) borders.left = buildBorder(p.borders.left);
        if (p.borders.right !== undefined) borders.right = buildBorder(p.borders.right);
        if (p.borders.innerHorizontal !== undefined) borders.innerHorizontal = buildBorder(p.borders.innerHorizontal);
        if (p.borders.innerVertical !== undefined) borders.innerVertical = buildBorder(p.borders.innerVertical);

        await sheetsBatchUpdate(token, p.spreadsheetId, [
          { updateBorders: { range: gridRange, ...borders } },
        ]);
        return { success: true, data: { range: p.range } };
      }

      case 'sheets.freeze_rows_and_columns': {
        const p = freezeRowsAndColumnsDef.params.parse(params);
        await freezeRowsAndColumns(
          token,
          p.spreadsheetId,
          p.sheetName,
          p.frozenRowCount,
          p.frozenColumnCount,
        );
        return {
          success: true,
          data: { frozenRowCount: p.frozenRowCount, frozenColumnCount: p.frozenColumnCount },
        };
      }

      // ── Tables ─────────────────────────────────────────────────────────

      case 'sheets.create_table': {
        const p = createTable.params.parse(params);
        const { sheetName: rangeSN, a1Range } = parseRange(p.range);
        const sn = p.sheetName || rangeSN;
        const sheetId = await resolveSheetId(token, p.spreadsheetId, sn);
        const gridRange = parseA1ToGridRange(a1Range, sheetId);

        const columnProperties = p.columns?.map((name: string, index: number) => ({
          columnIndex: index,
          columnName: name,
        }));

        const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            addTable: {
              table: {
                name: p.name,
                range: gridRange,
                ...(columnProperties ? { columnProperties } : {}),
              },
            },
          },
        ]);

        const replies = (data as { replies?: Array<{ addTable?: { table?: Record<string, unknown> } }> }).replies;
        const table = replies?.[0]?.addTable?.table;
        return {
          success: true,
          data: {
            tableId: table?.tableId,
            name: table?.name || p.name,
            range: p.range,
          },
        };
      }

      case 'sheets.get_table': {
        const p = getTable.params.parse(params);
        const { table, sheetName, sheetId } = await resolveTableIdentifier(
          token,
          p.spreadsheetId,
          p.tableIdentifier,
        );
        const tRange = table.range as { startRowIndex?: number; startColumnIndex?: number; endRowIndex?: number; endColumnIndex?: number } | undefined;
        const columns = (table.columnProperties as Array<{ columnIndex?: number; columnName?: string }> | undefined)?.map(
          (col) => ({ index: col.columnIndex, name: col.columnName }),
        ) || [];

        const range = tRange
          ? `${sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`
          : 'Unknown';

        return {
          success: true,
          data: {
            tableId: table.tableId,
            name: table.name,
            sheetName,
            sheetId,
            range,
            columns,
          },
        };
      }

      case 'sheets.list_tables': {
        const p = listTablesDef.params.parse(params);
        const tables = await listAllTables(token, p.spreadsheetId, p.sheetName);

        const tableList = tables.map((item) => {
          const tRange = item.table.range as { startRowIndex?: number; startColumnIndex?: number; endRowIndex?: number; endColumnIndex?: number } | undefined;
          return {
            tableId: item.table.tableId,
            name: item.table.name,
            sheetName: item.sheetName,
            range: tRange
              ? `${item.sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`
              : 'Unknown',
          };
        });

        return {
          success: true,
          data: { count: tableList.length, tables: tableList },
        };
      }

      case 'sheets.delete_table': {
        const p = deleteTable.params.parse(params);
        // Resolve table to get metadata before deletion
        const { table, sheetName } = await resolveTableIdentifier(token, p.spreadsheetId, p.tableId);
        const tableId = (table.tableId as string) || p.tableId;
        const tRange = table.range as { startRowIndex?: number; startColumnIndex?: number; endRowIndex?: number; endColumnIndex?: number } | undefined;

        // The Sheets API deleteTable clears underlying cell data as a side effect.
        // When deleteData=false, save the data first so we can restore it after deletion.
        let savedData: unknown[][] | undefined;
        if (!p.deleteData && tRange) {
          const a1 = `${sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`;
          const readResult = await readRange(token, p.spreadsheetId, a1);
          if (readResult.values && readResult.values.length > 0) {
            savedData = readResult.values;
          }
        }

        await sheetsBatchUpdate(token, p.spreadsheetId, [
          { deleteTable: { tableId } },
        ]);

        // Restore cell data if we saved it (deleteData=false)
        if (savedData && tRange) {
          const a1 = `${sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`;
          await writeRange(token, p.spreadsheetId, a1, savedData);
        }

        // Clear data if explicitly requested (and deleteTable didn't already clear it)
        if (p.deleteData && tRange) {
          const a1 = `${sheetName}!${rowColToA1(tRange.startRowIndex || 0, tRange.startColumnIndex || 0)}:${rowColToA1((tRange.endRowIndex || 1) - 1, (tRange.endColumnIndex || 1) - 1)}`;
          await clearRange(token, p.spreadsheetId, a1);
        }

        return {
          success: true,
          data: { tableId, deleted: true, dataCleared: p.deleteData || false },
        };
      }

      case 'sheets.update_table_range': {
        const p = updateTableRange.params.parse(params);
        const { table, sheetName } = await resolveTableIdentifier(token, p.spreadsheetId, p.tableId);
        const { a1Range } = parseRange(p.range);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName || undefined);
        const newRange = parseA1ToGridRange(a1Range, sheetId);

        await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            updateTable: {
              table: { tableId: table.tableId || p.tableId, range: newRange },
              fields: 'range',
            },
          },
        ]);

        // Re-fetch updated table
        const updated = await resolveTableIdentifier(token, p.spreadsheetId, (table.tableId as string) || p.tableId);
        return {
          success: true,
          data: {
            tableId: updated.table.tableId,
            name: updated.table.name,
            newRange: p.range,
          },
        };
      }

      case 'sheets.append_table_rows': {
        const p = appendTableRows.params.parse(params);
        const { table, sheetName } = await resolveTableIdentifier(token, p.spreadsheetId, p.tableId);
        const tRange = table.range as { startRowIndex?: number; startColumnIndex?: number; endRowIndex?: number; endColumnIndex?: number } | undefined;

        if (!tRange) {
          return { success: false, error: 'Table does not have a range defined' };
        }

        const startRow = tRange.endRowIndex || 0;
        const startCol = tRange.startColumnIndex || 0;
        const endCol = tRange.endColumnIndex || 0;
        const range = `${sheetName}!${rowColToA1(startRow, startCol)}:${rowColToA1(startRow + p.values.length - 1, endCol - 1)}`;

        const data = await appendValues(token, p.spreadsheetId, range, p.values);

        // Auto-expand table range to include the newly appended rows
        const tableIdStr = (table.tableId as string) || p.tableId;
        const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName || undefined);
        const newEndRow = (tRange.endRowIndex || 0) + p.values.length;
        try {
          await sheetsBatchUpdate(token, p.spreadsheetId, [
            {
              updateTable: {
                table: {
                  tableId: tableIdStr,
                  range: {
                    sheetId,
                    startRowIndex: tRange.startRowIndex || 0,
                    startColumnIndex: tRange.startColumnIndex || 0,
                    endRowIndex: newEndRow,
                    endColumnIndex: tRange.endColumnIndex || 0,
                  },
                },
                fields: 'range',
              },
            },
          ]);
        } catch {
          // Table range expansion is best-effort — data is already written
        }

        return {
          success: true,
          data: {
            tableId: table.tableId,
            name: table.name,
            rowsAppended: p.values.length,
            updatedRange: (data as { updates?: { updatedRange?: string } }).updates?.updatedRange || range,
          },
        };
      }

      // ── Advanced ───────────────────────────────────────────────────────

      case 'sheets.group_rows': {
        const p = groupRows.params.parse(params);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
        await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            addDimensionGroup: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: p.startRow - 1,
                endIndex: p.endRow,
              },
            },
          },
        ]);
        return { success: true, data: { rows: `${p.startRow}:${p.endRow}` } };
      }

      case 'sheets.ungroup_all_rows': {
        const p = ungroupAllRows.params.parse(params);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
        let removed = 0;

        // deleteDimensionGroup removes one level at a time; loop until no groups remain
        for (;;) {
          try {
            await sheetsBatchUpdate(token, p.spreadsheetId, [
              {
                deleteDimensionGroup: {
                  range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 500 },
                },
              },
            ]);
            removed++;
          } catch {
            break;
          }
        }

        return { success: true, data: { levelsRemoved: removed } };
      }

      case 'sheets.insert_chart': {
        const p = insertChart.params.parse(params);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);

        // Support comma-separated ranges (e.g. "Sheet1!A1:A13,Sheet1!G1:G13")
        const rangeParts = p.sourceRange.split(',').map((r: string) => r.trim());
        const gridRanges = rangeParts.map((part: string) => {
          const { a1Range: a1 } = parseRange(part);
          return parseA1ToGridRange(a1, sheetId);
        });

        // Use the first range for dimension calculations; multi-range uses explicit sources
        const gridRange = gridRanges[0];
        const startRow = gridRange.startRowIndex ?? 0;
        const endRow = gridRange.endRowIndex ?? startRow + 1;
        const startCol = gridRange.startColumnIndex ?? 0;
        const endCol = gridRange.endColumnIndex ?? startCol + 1;

        const colCount = endCol - startCol;
        let chartSpec: Record<string, unknown> = {};

        if (p.chartType === 'PIE') {
          if (colCount < 2) {
            return {
              success: false,
              error: `PIE chart requires at least 2 columns (labels + numeric values), but the source range "${p.sourceRange}" has only ${colCount} column(s). Provide a range like "Sheet!A1:B10" where the first column has labels and the second has numeric values.`,
            };
          }
          chartSpec.pieChart = {
            legendPosition: 'LABELED_LEGEND',
            domain: {
              sourceRange: {
                sources: [{ sheetId, startRowIndex: startRow + 1, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: startCol + 1 }],
              },
            },
            series: {
              sourceRange: {
                sources: [{ sheetId, startRowIndex: startRow + 1, endRowIndex: endRow, startColumnIndex: startCol + 1, endColumnIndex: startCol + 2 }],
              },
            },
          };
        } else if (gridRanges.length > 1) {
          // Multi-range mode: first range = domain (labels), rest = series
          const domainRange = gridRanges[0];
          const seriesEntries = gridRanges.slice(1).map((gr: { startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number }) => ({
            series: {
              sourceRange: {
                sources: [{
                  sheetId,
                  startRowIndex: gr.startRowIndex ?? 0,
                  endRowIndex: gr.endRowIndex ?? (gr.startRowIndex ?? 0) + 1,
                  startColumnIndex: gr.startColumnIndex ?? 0,
                  endColumnIndex: gr.endColumnIndex ?? (gr.startColumnIndex ?? 0) + 1,
                }],
              },
            },
            targetAxis: 'LEFT_AXIS',
          }));

          chartSpec.basicChart = {
            chartType: p.chartType,
            legendPosition: 'BOTTOM_LEGEND',
            axis: [
              { position: 'BOTTOM_AXIS', title: '' },
              { position: 'LEFT_AXIS', title: '' },
            ],
            domains: [{
              domain: {
                sourceRange: {
                  sources: [{
                    sheetId,
                    startRowIndex: domainRange.startRowIndex ?? 0,
                    endRowIndex: domainRange.endRowIndex ?? (domainRange.startRowIndex ?? 0) + 1,
                    startColumnIndex: domainRange.startColumnIndex ?? 0,
                    endColumnIndex: domainRange.endColumnIndex ?? (domainRange.startColumnIndex ?? 0) + 1,
                  }],
                },
              },
              reversed: false,
            }],
            series: seriesEntries,
            headerCount: 1,
          };
        } else {
          // Single contiguous range: first column = domain, rest = series
          const seriesCount = endCol - startCol - 1;
          // BAR charts are horizontal — series values go on BOTTOM_AXIS, not LEFT_AXIS
          const seriesAxis = p.chartType === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS';
          const series = Array.from({ length: seriesCount }, (_, i) => ({
            series: {
              sourceRange: {
                sources: [{
                  sheetId,
                  startRowIndex: startRow,
                  endRowIndex: endRow,
                  startColumnIndex: startCol + 1 + i,
                  endColumnIndex: startCol + 2 + i,
                }],
              },
            },
            targetAxis: seriesAxis,
            // COMBO charts need per-series type — default first series to COLUMN, rest to LINE
            ...(p.chartType === 'COMBO' ? { type: i === 0 ? 'COLUMN' : 'LINE' } : {}),
          }));

          chartSpec.basicChart = {
            chartType: p.chartType,
            legendPosition: 'BOTTOM_LEGEND',
            axis: [
              { position: 'BOTTOM_AXIS', title: '' },
              { position: 'LEFT_AXIS', title: '' },
            ],
            domains: [{
              domain: {
                sourceRange: {
                  sources: [{
                    sheetId,
                    startRowIndex: startRow,
                    endRowIndex: endRow,
                    startColumnIndex: startCol,
                    endColumnIndex: startCol + 1,
                  }],
                },
              },
              reversed: false,
            }],
            series,
            headerCount: 1,
          };
        }

        if (p.title) chartSpec.title = p.title;

        // Determine anchor position — prefer anchorCell, fall back to rowIndex/columnIndex
        let anchorRow = 0;
        let anchorCol = endCol;
        if (p.position?.anchorCell) {
          const m = p.position.anchorCell.match(/^([A-Z]+)(\d+)$/i);
          if (m) {
            anchorRow = parseInt(m[2], 10) - 1;
            anchorCol = colLettersToIndex(m[1]);
          }
        } else if (p.position?.rowIndex !== undefined || p.position?.columnIndex !== undefined) {
          anchorRow = p.position.rowIndex ?? 0;
          anchorCol = p.position.columnIndex ?? 0;
        }

        const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
          {
            addChart: {
              chart: {
                spec: chartSpec,
                position: {
                  overlayPosition: {
                    anchorCell: { sheetId, rowIndex: anchorRow, columnIndex: anchorCol },
                    widthPixels: 600,
                    heightPixels: 400,
                  },
                },
              },
            },
          },
        ]);

        const replies = (data as { replies?: Array<{ addChart?: { chart?: { chartId?: number } } }> }).replies;
        const chartId = replies?.[0]?.addChart?.chart?.chartId;
        return { success: true, data: { chartId } };
      }

      case 'sheets.delete_chart': {
        const p = deleteChart.params.parse(params);
        await sheetsBatchUpdate(token, p.spreadsheetId, [
          { deleteEmbeddedObject: { objectId: p.chartId } },
        ]);
        return { success: true, data: { chartId: p.chartId, deleted: true } };
      }

      case 'sheets.add_conditional_formatting': {
        const p = addConditionalFormatting.params.parse(params);
        const { sheetName, a1Range } = parseRange(p.range);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName);
        const gridRanges = [parseA1ToGridRange(a1Range, sheetId)];

        const conditionValues = p.conditionValues.map((v: string) => ({ userEnteredValue: v }));
        const format: Record<string, unknown> = {};
        if (p.format.backgroundColor) {
          const bg = normalizeColor(p.format.backgroundColor);
          if (bg) format.backgroundColor = bg;
        }

        // Merge top-level bold/italic into textFormat (same pattern as format_cells)
        const mergedTF = { ...p.format.textFormat };
        if ((p.format as Record<string, unknown>).bold !== undefined && mergedTF.bold === undefined) {
          mergedTF.bold = (p.format as Record<string, unknown>).bold as boolean;
        }
        if ((p.format as Record<string, unknown>).italic !== undefined && mergedTF.italic === undefined) {
          mergedTF.italic = (p.format as Record<string, unknown>).italic as boolean;
        }
        const hasTF = mergedTF.foregroundColor !== undefined || mergedTF.bold !== undefined || mergedTF.italic !== undefined;

        if (hasTF) {
          const tf: Record<string, unknown> = {};
          if (mergedTF.foregroundColor) {
            const fg = normalizeColor(mergedTF.foregroundColor);
            if (fg) tf.foregroundColor = fg;
          }
          if (mergedTF.bold !== undefined) tf.bold = mergedTF.bold;
          if (mergedTF.italic !== undefined) tf.italic = mergedTF.italic;
          if (Object.keys(tf).length > 0) format.textFormat = tf;
        }

        await addConditionalFormatRule(
          token,
          p.spreadsheetId,
          gridRanges,
          p.conditionType,
          conditionValues,
          format,
        );
        return { success: true, data: { range: p.range } };
      }

      case 'sheets.delete_conditional_formatting': {
        const p = deleteConditionalFormatting.params.parse(params);
        await sheetsBatchUpdate(token, p.spreadsheetId, [
          { deleteConditionalFormatRule: { sheetId: p.sheetId, index: p.index } },
        ]);
        return { success: true, data: { sheetId: p.sheetId, index: p.index, deleted: true } };
      }

      case 'sheets.get_conditional_formatting': {
        const p = getConditionalFormatting.params.parse(params);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, p.sheetName);
        const qs = new URLSearchParams({
          fields: 'sheets(properties(sheetId,title),conditionalFormats)',
        });
        const res = await sheetsFetch(`/${encodeURIComponent(p.spreadsheetId)}?${qs}`, token);
        if (!res.ok) return sheetsError(res);

        const apiData = await res.json() as {
          sheets?: Array<{
            properties?: { sheetId?: number; title?: string };
            conditionalFormats?: Array<{
              booleanRule?: {
                condition?: { type?: string; values?: Array<{ userEnteredValue?: string }> };
                format?: Record<string, unknown>;
              };
              gradientRule?: unknown;
              ranges?: Array<{
                startColumnIndex?: number;
                endColumnIndex?: number;
                startRowIndex?: number;
                endRowIndex?: number;
              }>;
            }>;
          }>;
        };

        const sheet = apiData.sheets?.find((s) => s.properties?.sheetId === sheetId);
        const rules = sheet?.conditionalFormats ?? [];

        const ruleSummaries = rules.map((rule, idx) => {
          const condition = rule.booleanRule?.condition;
          const fmt = rule.booleanRule?.format ?? {};

          const ranges = (rule.ranges ?? []).map((r) => {
            const sc = r.startColumnIndex != null ? colIndexToLetters(r.startColumnIndex) : '';
            const ec = r.endColumnIndex != null ? colIndexToLetters(r.endColumnIndex - 1) : '';
            const sr = r.startRowIndex != null ? r.startRowIndex + 1 : '';
            const er = r.endRowIndex != null ? r.endRowIndex : '';
            return `${sc}${sr}:${ec}${er}`;
          });

          return {
            index: idx,
            kind: rule.gradientRule ? 'GRADIENT' : 'BOOLEAN',
            ranges,
            conditionType: condition?.type ?? null,
            conditionValues: (condition?.values ?? [])
              .map((v) => v.userEnteredValue)
              .filter((v): v is string => typeof v === 'string'),
            backgroundColor: (fmt as Record<string, unknown>).backgroundColor
              ? rgbToHex((fmt as Record<string, unknown>).backgroundColor as Record<string, number>)
              : null,
            textColor: ((fmt as Record<string, unknown>).textFormat as Record<string, unknown> | undefined)?.foregroundColor
              ? rgbToHex(((fmt as Record<string, unknown>).textFormat as Record<string, unknown>).foregroundColor as Record<string, number>)
              : null,
            bold: ((fmt as Record<string, unknown>).textFormat as Record<string, unknown> | undefined)?.bold ?? false,
            italic: ((fmt as Record<string, unknown>).textFormat as Record<string, unknown> | undefined)?.italic ?? false,
          };
        });

        return {
          success: true,
          data: {
            sheetName: sheet?.properties?.title ?? null,
            count: ruleSummaries.length,
            rules: ruleSummaries,
          },
        };
      }

      case 'sheets.set_dropdown_validation': {
        const p = setDropdownValidationDef.params.parse(params);
        await setDropdownValidation(
          token,
          p.spreadsheetId,
          p.range,
          p.values,
          p.strict ?? true,
          p.inputMessage,
        );
        const isClearing = !p.values || p.values.length === 0;
        return {
          success: true,
          data: {
            range: p.range,
            action: isClearing ? 'cleared' : 'set',
            ...(p.values ? { optionCount: p.values.length } : {}),
          },
        };
      }

      case 'sheets.protect_range': {
        const p = protectRange.params.parse(params);
        const { sheetName, a1Range } = parseRange(p.range);
        const sheetId = await resolveSheetId(token, p.spreadsheetId, sheetName);

        const protectedRangeObj: Record<string, unknown> = {
          description: p.description ?? '',
          warningOnly: p.warningOnly ?? false,
          range: parseA1ToGridRange(a1Range, sheetId),
        };

        const data = await sheetsBatchUpdate(token, p.spreadsheetId, [
          { addProtectedRange: { protectedRange: protectedRangeObj } },
        ]);

        const replies = (data as { replies?: Array<{ addProtectedRange?: { protectedRange?: { protectedRangeId?: number } } }> }).replies;
        const protectionId = replies?.[0]?.addProtectedRange?.protectedRange?.protectedRangeId;

        return {
          success: true,
          data: {
            protectedRangeId: protectionId,
            range: p.range,
            warningOnly: p.warningOnly ?? false,
          },
        };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ────────────────────────────────────────────────────────────────

export const sheetsActionDefs: ActionDefinition[] = withGoogleWorkspaceOutputSchemas(allActions);
export { executeAction as executeSheetsAction };
