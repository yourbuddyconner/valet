import { z } from 'zod';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Color {
  red?: number;
  green?: number;
  blue?: number;
  alpha?: number;
}

export interface Border {
  style: 'NONE' | 'SOLID' | 'SOLID_MEDIUM' | 'SOLID_THICK' | 'DASHED' | 'DOTTED' | 'DOUBLE';
  color?: Color;
}

export interface CellFormat {
  backgroundColor?: Color;
  textFormat?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    fontSize?: number;
    fontFamily?: string;
    foregroundColor?: Color;
  };
  horizontalAlignment?: 'LEFT' | 'CENTER' | 'RIGHT';
  verticalAlignment?: 'TOP' | 'MIDDLE' | 'BOTTOM';
  wrapStrategy?: 'OVERFLOW_CELL' | 'CLIP' | 'WRAP';
  numberFormat?: {
    type: 'TEXT' | 'NUMBER' | 'PERCENT' | 'CURRENCY' | 'DATE' | 'TIME' | 'DATE_TIME' | 'SCIENTIFIC';
    pattern?: string;
  };
  borders?: {
    top?: Border;
    bottom?: Border;
    left?: Border;
    right?: Border;
  };
}

export interface Merge {
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
  sheetId: number;
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const colorSchema = z.object({
  red: z.number().min(0).max(1).optional(),
  green: z.number().min(0).max(1).optional(),
  blue: z.number().min(0).max(1).optional(),
  alpha: z.number().min(0).max(1).optional(),
}).describe('RGB color with 0-1 float values');

const borderSchema = z.object({
  style: z.enum(['NONE', 'SOLID', 'SOLID_MEDIUM', 'SOLID_THICK', 'DASHED', 'DOTTED', 'DOUBLE']),
  color: colorSchema.optional(),
});

export const cellFormatSchema = z.object({
  backgroundColor: colorSchema.optional(),
  textFormat: z.object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    underline: z.boolean().optional(),
    fontSize: z.number().optional(),
    fontFamily: z.string().optional(),
    foregroundColor: colorSchema.optional(),
  }).optional(),
  horizontalAlignment: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(),
  verticalAlignment: z.enum(['TOP', 'MIDDLE', 'BOTTOM']).optional(),
  wrapStrategy: z.enum(['OVERFLOW_CELL', 'CLIP', 'WRAP']).optional(),
  numberFormat: z.object({
    type: z.enum(['TEXT', 'NUMBER', 'PERCENT', 'CURRENCY', 'DATE', 'TIME', 'DATE_TIME', 'SCIENTIFIC']),
    pattern: z.string().optional(),
  }).optional(),
  borders: z.object({
    top: borderSchema.optional(),
    bottom: borderSchema.optional(),
    left: borderSchema.optional(),
    right: borderSchema.optional(),
  }).optional(),
}).describe('Cell formatting properties');

export const mergeSchema = z.object({
  startRowIndex: z.number().int(),
  endRowIndex: z.number().int(),
  startColumnIndex: z.number().int(),
  endColumnIndex: z.number().int(),
  sheetId: z.number().int(),
});

// ─── Field Mask Builder ─────────────────────────────────────────────────────

const LEAF_PROPERTIES = new Set([
  'backgroundColor', 'foregroundColor', 'numberFormat',
]);

export function buildFieldMask(format: CellFormat): string {
  const paths: string[] = [];

  for (const [key, value] of Object.entries(format)) {
    if (value === undefined) continue;

    if (LEAF_PROPERTIES.has(key) || typeof value !== 'object') {
      paths.push(`userEnteredFormat.${key}`);
    } else if (key === 'textFormat') {
      for (const [tfKey, tfValue] of Object.entries(value as Record<string, unknown>)) {
        if (tfValue === undefined) continue;
        paths.push(`userEnteredFormat.textFormat.${tfKey}`);
      }
    } else if (key === 'borders') {
      for (const [side, sideValue] of Object.entries(value as Record<string, unknown>)) {
        if (sideValue === undefined) continue;
        paths.push(`userEnteredFormat.borders.${side}`);
      }
    }
  }

  return paths.join(',');
}

// ─── API Response Normalization ─────────────────────────────────────────────

export function normalizeFormat(raw: Record<string, unknown>): CellFormat {
  const result: CellFormat = {};

  // backgroundColor: prefer plain, fallback to backgroundColorStyle.rgbColor
  if (raw.backgroundColor) {
    result.backgroundColor = raw.backgroundColor as Color;
  } else if (raw.backgroundColorStyle) {
    const style = raw.backgroundColorStyle as { rgbColor?: Color };
    if (style.rgbColor) result.backgroundColor = style.rgbColor;
  }

  // textFormat: normalize foregroundColor inside it
  if (raw.textFormat) {
    const tf = raw.textFormat as Record<string, unknown>;
    const normalized: CellFormat['textFormat'] = {};

    if (tf.bold !== undefined) normalized.bold = tf.bold as boolean;
    if (tf.italic !== undefined) normalized.italic = tf.italic as boolean;
    if (tf.strikethrough !== undefined) normalized.strikethrough = tf.strikethrough as boolean;
    if (tf.underline !== undefined) normalized.underline = tf.underline as boolean;
    if (tf.fontSize !== undefined) normalized.fontSize = tf.fontSize as number;
    if (tf.fontFamily !== undefined) normalized.fontFamily = tf.fontFamily as string;

    if (tf.foregroundColor) {
      normalized.foregroundColor = tf.foregroundColor as Color;
    } else if (tf.foregroundColorStyle) {
      const style = tf.foregroundColorStyle as { rgbColor?: Color };
      if (style.rgbColor) normalized.foregroundColor = style.rgbColor;
    }

    if (Object.keys(normalized).length > 0) result.textFormat = normalized;
  }

  if (raw.horizontalAlignment) result.horizontalAlignment = raw.horizontalAlignment as CellFormat['horizontalAlignment'];
  if (raw.verticalAlignment) result.verticalAlignment = raw.verticalAlignment as CellFormat['verticalAlignment'];
  if (raw.wrapStrategy) result.wrapStrategy = raw.wrapStrategy as CellFormat['wrapStrategy'];
  if (raw.numberFormat) result.numberFormat = raw.numberFormat as CellFormat['numberFormat'];
  if (raw.borders) result.borders = raw.borders as CellFormat['borders'];

  return result;
}

interface SheetsFormattingApiResponse {
  sheets: Array<{
    properties?: { sheetId: number; title: string };
    data: Array<{
      rowData?: Array<{
        values?: Array<{ userEnteredFormat?: Record<string, unknown> }>;
      }>;
    }>;
    merges?: Merge[];
  }>;
}

export function normalizeFormatsResponse(
  apiResponse: SheetsFormattingApiResponse,
  requestedRange: string,
): { range: string; formats: CellFormat[][]; merges: Merge[] } {
  const sheet = apiResponse.sheets[0];
  const rowData = sheet?.data?.[0]?.rowData ?? [];

  const formats: CellFormat[][] = rowData.map((row) => {
    const values = row.values ?? [];
    return values.map((cell) => {
      if (!cell.userEnteredFormat) return {};
      return normalizeFormat(cell.userEnteredFormat);
    });
  });

  const merges: Merge[] = (sheet?.merges ?? []).map((m) => ({
    startRowIndex: m.startRowIndex,
    endRowIndex: m.endRowIndex,
    startColumnIndex: m.startColumnIndex,
    endColumnIndex: m.endColumnIndex,
    sheetId: m.sheetId,
  }));

  return { range: requestedRange, formats, merges };
}
