# Google Sheets Formatting Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cell formatting read/write to the Google Sheets plugin so the agent can inspect existing styles, match them when writing data, and create well-formatted spreadsheets from scratch.

**Architecture:** New `formatting.ts` module handles all formatting logic (types, field mask construction, API response normalization, batchUpdate request building). Existing `actions.ts` gets two new action definitions and two modified ones. Tests mock `fetch` to verify request construction and response normalization without hitting the real API.

**Tech Stack:** TypeScript, Zod, Google Sheets API v4 (`batchUpdate`, `repeatCellRequest`, `updateCellsRequest`), Vitest

**Spec:** `docs/specs/2026-03-16-sheets-formatting-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/plugin-google-sheets/src/actions/formatting.ts` | Create | CellFormat/Color/Border/Merge types, Zod schemas, field mask builder, API response normalizer, batchUpdate request builders |
| `packages/plugin-google-sheets/src/actions/formatting.test.ts` | Create | Unit tests for field mask builder, response normalizer, request builders |
| `packages/plugin-google-sheets/src/actions/actions.ts` | Modify | Add `read_formatting` and `format_cells` definitions + execution; add optional `format`/`formats` params to `write_range` and `append_rows` |
| `packages/plugin-google-sheets/src/actions/actions.test.ts` | Create | Tests for action execution (mocked fetch): verifies correct API calls, request bodies, response shapes |
| `packages/plugin-google-sheets/vitest.config.ts` | Create | Vitest config (same pattern as `plugin-google-docs`) |
| `packages/plugin-google-sheets/skills/google-sheets.md` | Modify | Add formatting sections: reading & matching styles, color reference, recipes, best practices |

---

## Chunk 1: Formatting Module (Types, Field Mask, Normalization)

### Task 1: Vitest config and formatting types

**Files:**
- Create: `packages/plugin-google-sheets/vitest.config.ts`
- Create: `packages/plugin-google-sheets/src/actions/formatting.ts`

- [ ] **Step 1: Create vitest config**

```typescript
// packages/plugin-google-sheets/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Create formatting.ts with types and Zod schemas**

```typescript
// packages/plugin-google-sheets/src/actions/formatting.ts
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
```

- [ ] **Step 3: Verify it compiles**

Run: `cd packages/plugin-google-sheets && pnpm typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-google-sheets/vitest.config.ts packages/plugin-google-sheets/src/actions/formatting.ts
git commit -m "feat(sheets): add formatting types and Zod schemas"
```

### Task 2: Field mask builder

**Files:**
- Modify: `packages/plugin-google-sheets/src/actions/formatting.ts`
- Create: `packages/plugin-google-sheets/src/actions/formatting.test.ts`

- [ ] **Step 1: Write failing tests for buildFieldMask**

```typescript
// packages/plugin-google-sheets/src/actions/formatting.test.ts
import { describe, it, expect } from 'vitest';
import { buildFieldMask } from './formatting.js';

describe('buildFieldMask', () => {
  it('returns mask for a single top-level property', () => {
    const mask = buildFieldMask({ backgroundColor: { red: 1 } });
    expect(mask).toBe('userEnteredFormat.backgroundColor');
  });

  it('returns mask for nested textFormat properties', () => {
    const mask = buildFieldMask({ textFormat: { bold: true, fontSize: 12 } });
    const parts = mask.split(',').sort();
    expect(parts).toEqual([
      'userEnteredFormat.textFormat.bold',
      'userEnteredFormat.textFormat.fontSize',
    ]);
  });

  it('returns mask for textFormat.foregroundColor as a single leaf', () => {
    const mask = buildFieldMask({ textFormat: { foregroundColor: { red: 1 } } });
    expect(mask).toBe('userEnteredFormat.textFormat.foregroundColor');
  });

  it('returns mask for border sides', () => {
    const mask = buildFieldMask({
      borders: { top: { style: 'SOLID' }, bottom: { style: 'DASHED' } },
    });
    const parts = mask.split(',').sort();
    expect(parts).toEqual([
      'userEnteredFormat.borders.bottom',
      'userEnteredFormat.borders.top',
    ]);
  });

  it('returns mask for multiple top-level properties', () => {
    const mask = buildFieldMask({
      backgroundColor: { red: 0.5 },
      horizontalAlignment: 'CENTER',
    });
    const parts = mask.split(',').sort();
    expect(parts).toEqual([
      'userEnteredFormat.backgroundColor',
      'userEnteredFormat.horizontalAlignment',
    ]);
  });

  it('combines all property types', () => {
    const mask = buildFieldMask({
      backgroundColor: { red: 1 },
      textFormat: { bold: true },
      horizontalAlignment: 'LEFT',
      wrapStrategy: 'WRAP',
      numberFormat: { type: 'NUMBER' },
      borders: { left: { style: 'SOLID' } },
    });
    const parts = mask.split(',').sort();
    expect(parts).toEqual([
      'userEnteredFormat.backgroundColor',
      'userEnteredFormat.borders.left',
      'userEnteredFormat.horizontalAlignment',
      'userEnteredFormat.numberFormat',
      'userEnteredFormat.textFormat.bold',
      'userEnteredFormat.wrapStrategy',
    ]);
  });

  it('returns empty string for empty format', () => {
    expect(buildFieldMask({})).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: FAIL — `buildFieldMask` is not exported

- [ ] **Step 3: Implement buildFieldMask**

Add to `formatting.ts`:

```typescript
// ─── Field Mask Builder ─────────────────────────────────────────────────────

// Properties where the value is a leaf (not recursed into for mask paths).
// backgroundColor, foregroundColor, and numberFormat are objects but map to a single mask path.
const LEAF_PROPERTIES = new Set([
  'backgroundColor', 'foregroundColor', 'numberFormat',
]);

/**
 * Build a Google Sheets API fields mask from a CellFormat object.
 * Produces comma-separated dotted paths relative to CellData, e.g.:
 *   "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold"
 *
 * Rules:
 * - Top-level scalar properties → userEnteredFormat.{key}
 * - Top-level object leaves (backgroundColor, numberFormat) → userEnteredFormat.{key}
 * - textFormat nested scalars → userEnteredFormat.textFormat.{key}
 * - textFormat.foregroundColor (object leaf) → userEnteredFormat.textFormat.foregroundColor
 * - borders.{side} → userEnteredFormat.borders.{side}
 */
export function buildFieldMask(format: CellFormat): string {
  const paths: string[] = [];

  for (const [key, value] of Object.entries(format)) {
    if (value === undefined) continue;

    if (LEAF_PROPERTIES.has(key) || typeof value !== 'object') {
      // Scalar or object-leaf: single path
      paths.push(`userEnteredFormat.${key}`);
    } else if (key === 'textFormat') {
      // Recurse one level into textFormat
      for (const [tfKey, tfValue] of Object.entries(value as Record<string, unknown>)) {
        if (tfValue === undefined) continue;
        paths.push(`userEnteredFormat.textFormat.${tfKey}`);
      }
    } else if (key === 'borders') {
      // Each border side is a leaf
      for (const [side, sideValue] of Object.entries(value as Record<string, unknown>)) {
        if (sideValue === undefined) continue;
        paths.push(`userEnteredFormat.borders.${side}`);
      }
    }
  }

  return paths.join(',');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: all `buildFieldMask` tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-google-sheets/src/actions/formatting.ts packages/plugin-google-sheets/src/actions/formatting.test.ts
git commit -m "feat(sheets): add field mask builder for formatting"
```

### Task 3: API response normalizer

**Files:**
- Modify: `packages/plugin-google-sheets/src/actions/formatting.ts`
- Modify: `packages/plugin-google-sheets/src/actions/formatting.test.ts`

- [ ] **Step 1: Write failing tests for normalizeFormat**

Append to `formatting.test.ts`:

```typescript
import { buildFieldMask, normalizeFormat, normalizeFormatsResponse } from './formatting.js';

describe('normalizeFormat', () => {
  it('passes through plain color fields unchanged', () => {
    const input = {
      backgroundColor: { red: 0.5, green: 0.5, blue: 0.5 },
      textFormat: { bold: true, foregroundColor: { red: 1, green: 0, blue: 0 } },
    };
    const result = normalizeFormat(input);
    expect(result).toEqual(input);
  });

  it('extracts rgbColor from backgroundColorStyle when backgroundColor is absent', () => {
    const input = {
      backgroundColorStyle: { rgbColor: { red: 0.8, green: 0.9, blue: 1 } },
    };
    const result = normalizeFormat(input);
    expect(result.backgroundColor).toEqual({ red: 0.8, green: 0.9, blue: 1 });
    expect(result).not.toHaveProperty('backgroundColorStyle');
  });

  it('extracts rgbColor from textFormat.foregroundColorStyle when foregroundColor is absent', () => {
    const input = {
      textFormat: {
        bold: true,
        foregroundColorStyle: { rgbColor: { red: 0.2, green: 0.3, blue: 0.4 } },
      },
    };
    const result = normalizeFormat(input);
    expect(result.textFormat?.foregroundColor).toEqual({ red: 0.2, green: 0.3, blue: 0.4 });
    expect(result.textFormat).not.toHaveProperty('foregroundColorStyle');
  });

  it('prefers plain color over *Style when both are present', () => {
    const input = {
      backgroundColor: { red: 1, green: 1, blue: 1 },
      backgroundColorStyle: { rgbColor: { red: 0.5, green: 0.5, blue: 0.5 } },
    };
    const result = normalizeFormat(input);
    expect(result.backgroundColor).toEqual({ red: 1, green: 1, blue: 1 });
  });

  it('returns empty object for empty input', () => {
    expect(normalizeFormat({})).toEqual({});
  });

  it('passes through non-color properties unchanged', () => {
    const input = {
      horizontalAlignment: 'CENTER',
      wrapStrategy: 'WRAP',
      numberFormat: { type: 'NUMBER', pattern: '#,##0' },
      borders: { top: { style: 'SOLID', color: { red: 0 } } },
    };
    const result = normalizeFormat(input);
    expect(result).toEqual(input);
  });
});

describe('normalizeFormatsResponse', () => {
  it('converts API rowData into 2D CellFormat grid', () => {
    const apiResponse = {
      sheets: [{
        properties: { sheetId: 0, title: 'Sheet1' },
        data: [{
          rowData: [
            {
              values: [
                { userEnteredFormat: { backgroundColor: { red: 1 } } },
                { userEnteredFormat: { textFormat: { bold: true } } },
              ],
            },
            {
              values: [
                { userEnteredFormat: {} },
                {},
              ],
            },
          ],
        }],
        merges: [],
      }],
    };
    const result = normalizeFormatsResponse(apiResponse, 'Sheet1!A1:B2');
    expect(result.formats).toEqual([
      [{ backgroundColor: { red: 1 } }, { textFormat: { bold: true } }],
      [{}, {}],
    ]);
    expect(result.merges).toEqual([]);
    expect(result.range).toBe('Sheet1!A1:B2');
  });

  it('returns empty grid when no rowData', () => {
    const apiResponse = {
      sheets: [{
        properties: { sheetId: 0, title: 'Sheet1' },
        data: [{ rowData: [] }],
        merges: [],
      }],
    };
    const result = normalizeFormatsResponse(apiResponse, 'Sheet1!A1:A1');
    expect(result.formats).toEqual([]);
  });

  it('includes merges from the response', () => {
    const apiResponse = {
      sheets: [{
        properties: { sheetId: 0, title: 'Sheet1' },
        data: [{ rowData: [] }],
        merges: [
          { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 },
        ],
      }],
    };
    const result = normalizeFormatsResponse(apiResponse, 'Sheet1!A1:C2');
    expect(result.merges).toEqual([
      { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: FAIL — `normalizeFormat` and `normalizeFormatsResponse` not exported

- [ ] **Step 3: Implement normalizeFormat and normalizeFormatsResponse**

Add to `formatting.ts`:

```typescript
// ─── API Response Normalization ─────────────────────────────────────────────

/**
 * Normalize a single CellFormat from the Sheets API response.
 * - Extracts rgbColor from *Style fields when plain Color is absent
 * - Strips *Style fields from the output
 */
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

  // Pass through remaining standard properties
  if (raw.horizontalAlignment) result.horizontalAlignment = raw.horizontalAlignment as CellFormat['horizontalAlignment'];
  if (raw.verticalAlignment) result.verticalAlignment = raw.verticalAlignment as CellFormat['verticalAlignment'];
  if (raw.wrapStrategy) result.wrapStrategy = raw.wrapStrategy as CellFormat['wrapStrategy'];
  if (raw.numberFormat) result.numberFormat = raw.numberFormat as CellFormat['numberFormat'];
  if (raw.borders) result.borders = raw.borders as CellFormat['borders'];

  return result;
}

/** Shape of the Sheets API response when requesting formatting fields. */
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

/**
 * Transform the raw Sheets API formatting response into a normalized
 * { range, formats: CellFormat[][], merges: Merge[] } result.
 */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-google-sheets/src/actions/formatting.ts packages/plugin-google-sheets/src/actions/formatting.test.ts
git commit -m "feat(sheets): add format normalizer for API responses"
```

### Task 4: batchUpdate request builders

**Files:**
- Modify: `packages/plugin-google-sheets/src/actions/formatting.ts`
- Modify: `packages/plugin-google-sheets/src/actions/formatting.test.ts`

- [ ] **Step 1: Write failing tests for request builders**

Append to `formatting.test.ts`:

```typescript
import {
  buildFieldMask,
  normalizeFormat,
  normalizeFormatsResponse,
  buildRepeatCellRequest,
  buildUpdateCellsRequest,
  buildMergeRequests,
  parseA1Range,
} from './formatting.js';

describe('parseA1Range', () => {
  it('parses Sheet1!A1:C3', () => {
    expect(parseA1Range('Sheet1!A1:C3', 0)).toEqual({
      sheetId: 0,
      startRowIndex: 0,
      endRowIndex: 3,
      startColumnIndex: 0,
      endColumnIndex: 3,
    });
  });

  it('parses A1:B2 (no sheet name) with given sheetId', () => {
    expect(parseA1Range('A1:B2', 0)).toEqual({
      sheetId: 0,
      startRowIndex: 0,
      endRowIndex: 2,
      startColumnIndex: 0,
      endColumnIndex: 2,
    });
  });

  it('parses multi-letter columns like AA1:AC5', () => {
    expect(parseA1Range('AA1:AC5', 0)).toEqual({
      sheetId: 0,
      startRowIndex: 0,
      endRowIndex: 5,
      startColumnIndex: 26,
      endColumnIndex: 29,
    });
  });

  it('parses single cell A1', () => {
    expect(parseA1Range('A1', 0)).toEqual({
      sheetId: 0,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: 1,
    });
  });

  it('handles quoted sheet names', () => {
    expect(parseA1Range("'My Sheet'!B2:D4", 5)).toEqual({
      sheetId: 5,
      startRowIndex: 1,
      endRowIndex: 4,
      startColumnIndex: 1,
      endColumnIndex: 4,
    });
  });
});

describe('buildRepeatCellRequest', () => {
  it('builds a repeatCell request with correct range and fields', () => {
    const format: CellFormat = { backgroundColor: { red: 1 }, textFormat: { bold: true } };
    const result = buildRepeatCellRequest(
      { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3 },
      format,
    );
    expect(result).toEqual({
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3 },
        cell: { userEnteredFormat: format },
        fields: expect.stringContaining('userEnteredFormat.backgroundColor'),
      },
    });
    expect(result.repeatCell.fields).toContain('userEnteredFormat.textFormat.bold');
  });
});

describe('buildUpdateCellsRequest', () => {
  it('builds updateCells request with per-cell formats and values', () => {
    const values = [['Hello', 42]];
    const formats = [[
      { backgroundColor: { red: 1 } },
      { textFormat: { bold: true } },
    ]];
    const result = buildUpdateCellsRequest(
      { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
      formats,
      values,
    );
    expect(result.updateCells.start).toEqual({ sheetId: 0, rowIndex: 0, columnIndex: 0 });
    expect(result.updateCells.rows).toHaveLength(1);
    expect(result.updateCells.rows[0].values).toHaveLength(2);
    // First cell: value + format
    expect(result.updateCells.rows[0].values[0].userEnteredFormat).toEqual({ backgroundColor: { red: 1 } });
    expect(result.updateCells.rows[0].values[0].userEnteredValue).toEqual({ stringValue: 'Hello' });
    // Second cell: value + format
    expect(result.updateCells.rows[0].values[1].userEnteredFormat).toEqual({ textFormat: { bold: true } });
    expect(result.updateCells.rows[0].values[1].userEnteredValue).toEqual({ numberValue: 42 });
    // Fields mask includes both value and format
    expect(result.updateCells.fields).toContain('userEnteredFormat');
    expect(result.updateCells.fields).toContain('userEnteredValue');
  });

  it('builds updateCells request with formats only (no values)', () => {
    const formats = [[{ backgroundColor: { red: 0.5 } }]];
    const result = buildUpdateCellsRequest(
      { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      formats,
    );
    expect(result.updateCells.rows[0].values[0].userEnteredFormat).toEqual({ backgroundColor: { red: 0.5 } });
    expect(result.updateCells.rows[0].values[0]).not.toHaveProperty('userEnteredValue');
    expect(result.updateCells.fields).not.toContain('userEnteredValue');
  });
});

describe('buildMergeRequests', () => {
  it('builds merge requests', () => {
    const merges: Merge[] = [
      { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 },
    ];
    const result = buildMergeRequests(merges, false);
    expect(result).toEqual([
      { mergeCells: { range: merges[0], mergeType: 'MERGE_ALL' } },
    ]);
  });

  it('builds unmerge + merge requests when unmerge is true', () => {
    const merges: Merge[] = [
      { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 },
    ];
    const result = buildMergeRequests(merges, true);
    expect(result[0]).toHaveProperty('unmergeCells');
    expect(result[1]).toHaveProperty('mergeCells');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement parseA1Range**

Add to `formatting.ts`:

```typescript
// ─── A1 Range Parsing ───────────────────────────────────────────────────────

interface GridRange {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

/** Convert a column letter string (A, B, ..., Z, AA, AB, ...) to 0-based index. */
function columnToIndex(col: string): number {
  let index = 0;
  for (let i = 0; i < col.length; i++) {
    index = index * 26 + (col.charCodeAt(i) - 64);
  }
  return index - 1;
}

/** Parse a cell reference like "A1" into { col: 0, row: 0 }. */
function parseCellRef(ref: string): { col: number; row: number } {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  return { col: columnToIndex(match[1]), row: parseInt(match[2], 10) - 1 };
}

/**
 * Parse A1 notation range into a GridRange with 0-based indices.
 * Supports: "Sheet1!A1:C3", "A1:B2", "A1", "'Sheet Name'!B2:D4"
 */
export function parseA1Range(range: string, sheetId: number): GridRange {
  // Strip sheet name if present
  let rangeOnly = range;
  const bangIndex = range.indexOf('!');
  if (bangIndex !== -1) {
    rangeOnly = range.slice(bangIndex + 1);
  }

  const parts = rangeOnly.split(':');
  const start = parseCellRef(parts[0]);

  if (parts.length === 1) {
    // Single cell
    return {
      sheetId,
      startRowIndex: start.row,
      endRowIndex: start.row + 1,
      startColumnIndex: start.col,
      endColumnIndex: start.col + 1,
    };
  }

  const end = parseCellRef(parts[1]);
  return {
    sheetId,
    startRowIndex: start.row,
    endRowIndex: end.row + 1,
    startColumnIndex: start.col,
    endColumnIndex: end.col + 1,
  };
}
```

- [ ] **Step 4: Implement buildRepeatCellRequest, buildUpdateCellsRequest, buildMergeRequests**

Add to `formatting.ts`:

```typescript
// ─── batchUpdate Request Builders ───────────────────────────────────────────

/** Build a repeatCellRequest that applies uniform formatting to a range. */
export function buildRepeatCellRequest(
  range: GridRange,
  format: CellFormat,
): { repeatCell: { range: GridRange; cell: { userEnteredFormat: CellFormat }; fields: string } } {
  return {
    repeatCell: {
      range,
      cell: { userEnteredFormat: format },
      fields: buildFieldMask(format),
    },
  };
}

/** Convert a JS value to a Sheets API userEnteredValue. */
function toUserEnteredValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined || val === '') return { stringValue: '' };
  if (typeof val === 'number') return { numberValue: val };
  if (typeof val === 'boolean') return { boolValue: val };
  const s = String(val);
  if (s.startsWith('=')) return { formulaValue: s };
  return { stringValue: s };
}

/**
 * Build an updateCellsRequest with per-cell formats and optional values.
 * Uses GridCoordinate start (not range) so it works for both write and append.
 */
export function buildUpdateCellsRequest(
  range: GridRange,
  formats: CellFormat[][],
  values?: unknown[][],
): {
  updateCells: {
    start: { sheetId: number; rowIndex: number; columnIndex: number };
    rows: Array<{
      values: Array<Record<string, unknown>>;
    }>;
    fields: string;
  };
} {
  const hasValues = values !== undefined;

  // Collect all format field paths across all cells for the unified mask
  const allFormatPaths = new Set<string>();
  for (const row of formats) {
    for (const fmt of row) {
      const mask = buildFieldMask(fmt);
      if (mask) mask.split(',').forEach((p) => allFormatPaths.add(p));
    }
  }

  const fieldParts = [...allFormatPaths];
  if (hasValues) fieldParts.push('userEnteredValue');
  const fields = fieldParts.join(',');

  const rows = formats.map((fmtRow, rowIdx) =>
    ({
      values: fmtRow.map((fmt, colIdx) => {
        const cell: Record<string, unknown> = {};
        if (Object.keys(fmt).length > 0) cell.userEnteredFormat = fmt;
        if (hasValues && values[rowIdx] !== undefined) {
          cell.userEnteredValue = toUserEnteredValue(values[rowIdx][colIdx]);
        }
        return cell;
      }),
    }),
  );

  return {
    updateCells: {
      start: { sheetId: range.sheetId, rowIndex: range.startRowIndex, columnIndex: range.startColumnIndex },
      rows,
      fields,
    },
  };
}

/** Build merge/unmerge requests for a batchUpdate call. */
export function buildMergeRequests(
  merges: Merge[],
  unmergeFirst: boolean,
): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];

  if (unmergeFirst) {
    for (const merge of merges) {
      requests.push({ unmergeCells: { range: merge } });
    }
  }

  for (const merge of merges) {
    requests.push({ mergeCells: { range: merge, mergeType: 'MERGE_ALL' } });
  }

  return requests;
}

// Re-export GridRange type for use in actions.ts
export type { GridRange };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: all tests PASS

- [ ] **Step 6: Typecheck**

Run: `cd packages/plugin-google-sheets && pnpm typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-google-sheets/src/actions/formatting.ts packages/plugin-google-sheets/src/actions/formatting.test.ts
git commit -m "feat(sheets): add A1 parser, batchUpdate request builders"
```

---

## Chunk 2: Action Definitions and Execution

### Task 5: Add `sheets.read_formatting` action

**Files:**
- Modify: `packages/plugin-google-sheets/src/actions/actions.ts`
- Create: `packages/plugin-google-sheets/src/actions/actions.test.ts`

- [ ] **Step 1: Write failing test for read_formatting**

```typescript
// packages/plugin-google-sheets/src/actions/actions.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { googleSheetsActions } from './actions.js';
import type { ActionContext } from '@valet/sdk';

const mockCtx: ActionContext = {
  credentials: { access_token: 'test-token' },
  userId: 'user-1',
};

describe('sheets.read_formatting', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the correct API endpoint with formatting fields', async () => {
    const mockResponse = {
      sheets: [{
        properties: { sheetId: 0, title: 'Sheet1' },
        data: [{
          rowData: [
            { values: [{ userEnteredFormat: { backgroundColor: { red: 1, green: 0.95, blue: 0.8 } } }] },
          ],
        }],
        merges: [],
      }],
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await googleSheetsActions.execute(
      'sheets.read_formatting',
      { spreadsheetId: 'abc123', range: 'Sheet1!A1:A1' },
      mockCtx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      range: 'Sheet1!A1:A1',
      formats: [[{ backgroundColor: { red: 1, green: 0.95, blue: 0.8 } }]],
      merges: [],
    });

    // Verify the fetch URL includes the right fields
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toContain('sheets.data.rowData.values.userEnteredFormat');
    expect(url).toContain('sheets.merges');
    expect(url).toContain('sheets.properties.sheetId');
  });

  it('normalizes *Style color fields', async () => {
    const mockResponse = {
      sheets: [{
        properties: { sheetId: 0, title: 'Sheet1' },
        data: [{
          rowData: [
            {
              values: [{
                userEnteredFormat: {
                  backgroundColorStyle: { rgbColor: { red: 0.5, green: 0.5, blue: 0.5 } },
                },
              }],
            },
          ],
        }],
        merges: [],
      }],
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await googleSheetsActions.execute(
      'sheets.read_formatting',
      { spreadsheetId: 'abc123', range: 'Sheet1!A1:A1' },
      mockCtx,
    );

    expect(result.success).toBe(true);
    expect((result.data as { formats: Array<Array<{ backgroundColor?: unknown }>> }).formats[0][0].backgroundColor).toEqual({
      red: 0.5, green: 0.5, blue: 0.5,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: FAIL — action not found

- [ ] **Step 3: Add read_formatting definition and execution to actions.ts**

Add the import at the top of `actions.ts`:

```typescript
import { cellFormatSchema, mergeSchema, normalizeFormatsResponse, parseA1Range, buildRepeatCellRequest, buildUpdateCellsRequest, buildMergeRequests } from './formatting.js';
import type { CellFormat } from './formatting.js';
```

Add the action definition (after `deleteSheet` and before `allActions`):

```typescript
const readFormatting: ActionDefinition = {
  id: 'sheets.read_formatting',
  name: 'Read Formatting',
  description:
    'Read cell formatting (colors, bold, borders, alignment, etc.) from a range. Use this to inspect existing styles before writing data so you can match them.',
  riskLevel: 'low',
  params: z.object({
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range to inspect (e.g. "Sheet1!A1:F10")'),
  }),
};
```

Add `readFormatting` to the `allActions` array.

Add the case to `executeAction`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-google-sheets/src/actions/actions.ts packages/plugin-google-sheets/src/actions/actions.test.ts
git commit -m "feat(sheets): add read_formatting action"
```

### Task 6: Add `sheets.format_cells` action

**Files:**
- Modify: `packages/plugin-google-sheets/src/actions/actions.ts`
- Modify: `packages/plugin-google-sheets/src/actions/actions.test.ts`

- [ ] **Step 1: Write failing tests for format_cells**

Append to `actions.test.ts`:

```typescript
describe('sheets.format_cells', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends repeatCellRequest for uniform format', async () => {
    // First call: get_spreadsheet to resolve sheetId
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
        }),
      })
      // Second call: batchUpdate
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ replies: [] }),
      });

    const result = await googleSheetsActions.execute(
      'sheets.format_cells',
      {
        spreadsheetId: 'abc123',
        range: 'Sheet1!A1:C3',
        format: { backgroundColor: { red: 1, green: 0, blue: 0 } },
      },
      mockCtx,
    );

    expect(result.success).toBe(true);

    // Verify batchUpdate was called (second fetch)
    const batchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(batchCall[1].body);
    expect(body.requests[0]).toHaveProperty('repeatCell');
    expect(body.requests[0].repeatCell.cell.userEnteredFormat.backgroundColor).toEqual({
      red: 1, green: 0, blue: 0,
    });
  });

  it('sends updateCellsRequest for per-cell formats', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ replies: [] }),
      });

    const result = await googleSheetsActions.execute(
      'sheets.format_cells',
      {
        spreadsheetId: 'abc123',
        range: 'Sheet1!A1:B1',
        formats: [[
          { textFormat: { bold: true } },
          { textFormat: { italic: true } },
        ]],
      },
      mockCtx,
    );

    expect(result.success).toBe(true);
    const batchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(batchCall[1].body);
    expect(body.requests[0]).toHaveProperty('updateCells');
  });

  it('includes merge requests when merges provided', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ replies: [] }),
      });

    const result = await googleSheetsActions.execute(
      'sheets.format_cells',
      {
        spreadsheetId: 'abc123',
        range: 'Sheet1!A1:C1',
        format: { textFormat: { bold: true } },
        merges: [{ sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 }],
      },
      mockCtx,
    );

    expect(result.success).toBe(true);
    const batchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(batchCall[1].body);
    const hasMerge = body.requests.some((r: Record<string, unknown>) => 'mergeCells' in r);
    expect(hasMerge).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: FAIL — action not found

- [ ] **Step 3: Add format_cells definition and execution to actions.ts**

Add the action definition:

```typescript
const formatCells: ActionDefinition = {
  id: 'sheets.format_cells',
  name: 'Format Cells',
  description:
    'Apply formatting (colors, bold, borders, alignment, number format, etc.) to a range. Use "format" for uniform styling or "formats" for per-cell styling. Can also merge/unmerge cells.',
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
```

Add `formatCells` to the `allActions` array.

Add a helper to resolve sheetId from a range string (needed for A1 parsing):

```typescript
/** Resolve the sheetId for a range by fetching spreadsheet metadata. */
async function resolveSheetId(spreadsheetId: string, range: string, token: string): Promise<number> {
  // Extract sheet name from range (before the !)
  const bangIndex = range.indexOf('!');
  let sheetName = bangIndex !== -1 ? range.slice(0, bangIndex).replace(/^'|'$/g, '') : '';

  if (!sheetName) {
    // No sheet name — use the first sheet (sheetId 0 is common but not guaranteed)
    const qs = new URLSearchParams({ fields: 'sheets.properties.sheetId,sheets.properties.title' });
    const res = await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}?${qs}`, token);
    if (!res.ok) return 0;
    const data = await res.json() as { sheets: Array<{ properties: { sheetId: number; title: string } }> };
    return data.sheets[0]?.properties?.sheetId ?? 0;
  }

  const qs = new URLSearchParams({ fields: 'sheets.properties.sheetId,sheets.properties.title' });
  const res = await sheetsFetch(`/${encodeURIComponent(spreadsheetId)}?${qs}`, token);
  if (!res.ok) return 0;
  const data = await res.json() as { sheets: Array<{ properties: { sheetId: number; title: string } }> };
  const sheet = data.sheets.find((s) => s.properties.title === sheetName);
  return sheet?.properties?.sheetId ?? 0;
}
```

Add the case to `executeAction`:

```typescript
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
          {
            method: 'POST',
            body: JSON.stringify({ requests }),
          },
        );
        if (!res.ok) return sheetsError(res);

        return {
          success: true,
          data: {
            updatedRange: p.range,
            mergesApplied: p.merges?.length ?? 0,
          },
        };
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-google-sheets/src/actions/actions.ts packages/plugin-google-sheets/src/actions/actions.test.ts
git commit -m "feat(sheets): add format_cells action"
```

### Task 7: Add formatting support to `write_range`

**Files:**
- Modify: `packages/plugin-google-sheets/src/actions/actions.ts`
- Modify: `packages/plugin-google-sheets/src/actions/actions.test.ts`

- [ ] **Step 1: Write failing test for write_range with formatting**

Append to `actions.test.ts`:

```typescript
describe('sheets.write_range with formatting', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses values-only PUT when no formatting provided', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ updatedCells: 4 }),
    });

    const result = await googleSheetsActions.execute(
      'sheets.write_range',
      {
        spreadsheetId: 'abc123',
        range: 'Sheet1!A1:B2',
        values: [['a', 'b'], ['c', 'd']],
      },
      mockCtx,
    );

    expect(result.success).toBe(true);
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].method).toBe('PUT');
  });

  it('uses batchUpdate with updateCells when uniform format provided', async () => {
    // First call: resolve sheetId
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
        }),
      })
      // Second call: batchUpdate
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ replies: [] }),
      });

    const result = await googleSheetsActions.execute(
      'sheets.write_range',
      {
        spreadsheetId: 'abc123',
        range: 'Sheet1!A1:B1',
        values: [['Hello', 'World']],
        format: { backgroundColor: { red: 1 } },
      },
      mockCtx,
    );

    expect(result.success).toBe(true);
    // Verify batchUpdate was used
    const batchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(batchCall[1].body);
    expect(body.requests[0]).toHaveProperty('updateCells');
    // Both cells should have the value AND the format
    const cells = body.requests[0].updateCells.rows[0].values;
    expect(cells[0].userEnteredValue).toEqual({ stringValue: 'Hello' });
    expect(cells[0].userEnteredFormat).toEqual({ backgroundColor: { red: 1 } });
    expect(cells[1].userEnteredValue).toEqual({ stringValue: 'World' });
    expect(cells[1].userEnteredFormat).toEqual({ backgroundColor: { red: 1 } });
  });

  it('uses per-cell formats when formats array provided', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ replies: [] }),
      });

    const result = await googleSheetsActions.execute(
      'sheets.write_range',
      {
        spreadsheetId: 'abc123',
        range: 'Sheet1!A1:B1',
        values: [['Hello', 'World']],
        formats: [[{ textFormat: { bold: true } }, { textFormat: { italic: true } }]],
      },
      mockCtx,
    );

    expect(result.success).toBe(true);
    const batchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(batchCall[1].body);
    const cells = body.requests[0].updateCells.rows[0].values;
    expect(cells[0].userEnteredFormat).toEqual({ textFormat: { bold: true } });
    expect(cells[1].userEnteredFormat).toEqual({ textFormat: { italic: true } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: FAIL — `format` not a valid param

- [ ] **Step 3: Add format/formats params to writeRange and update execution**

Modify the `writeRange` definition to add optional formatting params:

```typescript
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
      .describe('How input should be interpreted (default: USER_ENTERED, which parses formulas). Ignored when formatting is provided.'),
    format: cellFormatSchema.optional().describe('Single format applied to all written cells'),
    formats: z.array(z.array(cellFormatSchema)).optional().describe('Per-cell formatting (must match values dimensions)'),
  }),
};
```

Modify the `sheets.write_range` case in `executeAction`:

```typescript
      case 'sheets.write_range': {
        const p = writeRange.params.parse(params);

        // If formatting is provided, use batchUpdate with updateCellsRequest
        if (p.format || p.formats) {
          const sheetId = await resolveSheetId(p.spreadsheetId, p.range, token);
          const gridRange = parseA1Range(p.range, sheetId);

          // Expand uniform format to per-cell grid matching values dimensions
          let cellFormats: CellFormat[][];
          if (p.formats) {
            cellFormats = p.formats;
          } else {
            cellFormats = p.values.map((row) => row.map(() => p.format!));
          }

          const request = buildUpdateCellsRequest(gridRange, cellFormats, p.values);
          const res = await sheetsFetch(
            `/${encodeURIComponent(p.spreadsheetId)}:batchUpdate`,
            token,
            {
              method: 'POST',
              body: JSON.stringify({ requests: [request] }),
            },
          );
          if (!res.ok) return sheetsError(res);
          return { success: true, data: await res.json() };
        }

        // No formatting — use the existing values-only PUT
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-google-sheets/src/actions/actions.ts packages/plugin-google-sheets/src/actions/actions.test.ts
git commit -m "feat(sheets): add optional formatting to write_range"
```

### Task 8: Add formatting support to `append_rows`

**Files:**
- Modify: `packages/plugin-google-sheets/src/actions/actions.ts`
- Modify: `packages/plugin-google-sheets/src/actions/actions.test.ts`

- [ ] **Step 1: Write failing tests for append_rows with formatting**

Append to `actions.test.ts`:

```typescript
describe('sheets.append_rows with formatting', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses values-only append when no formatting provided', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ updates: { updatedRows: 1 } }),
    });

    const result = await googleSheetsActions.execute(
      'sheets.append_rows',
      {
        spreadsheetId: 'abc123',
        range: 'Sheet1!A:D',
        values: [['a', 'b', 'c', 'd']],
      },
      mockCtx,
    );

    expect(result.success).toBe(true);
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toContain(':append');
  });

  it('discovers next row and uses batchUpdate when formatting provided', async () => {
    // Call 1: resolve sheetId
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
        }),
      })
      // Call 2: get spreadsheet metadata to find last row
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          sheets: [{
            properties: { sheetId: 0, title: 'Sheet1', gridProperties: { rowCount: 1000, columnCount: 26 } },
          }],
        }),
      })
      // Call 3: read values to find last row with data
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          values: [
            ['Header1', 'Header2'],
            ['Row1', 'Data1'],
            ['Row2', 'Data2'],
          ],
        }),
      })
      // Call 4: batchUpdate
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ replies: [] }),
      });

    const result = await googleSheetsActions.execute(
      'sheets.append_rows',
      {
        spreadsheetId: 'abc123',
        range: 'Sheet1!A:B',
        values: [['NewRow', 'NewData']],
        format: { backgroundColor: { red: 0.9, green: 0.95, blue: 0.9 } },
      },
      mockCtx,
    );

    expect(result.success).toBe(true);

    // Verify batchUpdate was called
    const batchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[3];
    const body = JSON.parse(batchCall[1].body);
    expect(body.requests[0]).toHaveProperty('updateCells');
    // Start row should be 3 (0-indexed, after 3 existing rows)
    expect(body.requests[0].updateCells.start.rowIndex).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: FAIL — `format` not a valid param

- [ ] **Step 3: Add format/formats params to appendRows and update execution**

Modify the `appendRows` definition:

```typescript
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
```

Add a helper function before `executeAction`:

```typescript
/**
 * Find the next empty row in a range by reading values and counting rows.
 * Returns the 0-based row index where new data should be written.
 */
async function findNextEmptyRow(
  spreadsheetId: string,
  range: string,
  token: string,
): Promise<number> {
  const res = await sheetsFetch(
    `/${encodeURIComponent(spreadsheetId)}/values/${range}`,
    token,
  );
  if (!res.ok) return 0;
  const data = await res.json() as { values?: unknown[][] };
  return data.values?.length ?? 0;
}
```

Modify the `sheets.append_rows` case in `executeAction`:

```typescript
      case 'sheets.append_rows': {
        const p = appendRows.params.parse(params);

        // If formatting is provided, use batchUpdate path
        if (p.format || p.formats) {
          const sheetId = await resolveSheetId(p.spreadsheetId, p.range, token);
          const nextRow = await findNextEmptyRow(p.spreadsheetId, p.range, token);

          // Build a grid range starting at the next empty row
          const gridRange = parseA1Range(p.range, sheetId);
          const startRange = {
            ...gridRange,
            startRowIndex: nextRow,
            endRowIndex: nextRow + p.values.length,
          };

          let cellFormats: CellFormat[][];
          if (p.formats) {
            cellFormats = p.formats;
          } else {
            cellFormats = p.values.map((row) => row.map(() => p.format!));
          }

          const request = buildUpdateCellsRequest(startRange, cellFormats, p.values);
          const res = await sheetsFetch(
            `/${encodeURIComponent(p.spreadsheetId)}:batchUpdate`,
            token,
            {
              method: 'POST',
              body: JSON.stringify({ requests: [request] }),
            },
          );
          if (!res.ok) return sheetsError(res);
          return { success: true, data: await res.json() };
        }

        // No formatting — use the existing append endpoint
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-google-sheets && pnpm test -- --reporter verbose`
Expected: all tests PASS

- [ ] **Step 5: Typecheck the full project**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-google-sheets/src/actions/actions.ts packages/plugin-google-sheets/src/actions/actions.test.ts
git commit -m "feat(sheets): add optional formatting to append_rows"
```

---

## Chunk 3: Skill Documentation and Registry

### Task 9: Update skill documentation

**Files:**
- Modify: `packages/plugin-google-sheets/skills/google-sheets.md`

- [ ] **Step 1: Add formatting sections to the skill doc**

After the existing "### Spreadsheet Management" section in the "## Available Tools" area, add:

```markdown
### Formatting

- **`sheets.read_formatting`** — Read cell formatting (colors, bold, borders, alignment) from a range. Always use this before writing to a styled spreadsheet so you can match existing styles.
- **`sheets.format_cells`** — Apply formatting to a range. Use `format` for uniform styling across all cells, or `formats` for per-cell control. Can also merge/unmerge cells.

**`sheets.write_range`** and **`sheets.append_rows`** also accept optional `format` or `formats` parameters to write values and styling in a single call.
```

After the existing "## Tips" section, add the full formatting guide:

```markdown
## Formatting

### Preserving Existing Styles

When editing a spreadsheet that already has styling, always match the existing formatting:

1. Read formatting from a reference row (usually the row above where you're inserting, or a representative data row):
   ```
   sheets.read_formatting({ spreadsheetId: "...", range: "Sheet1!A5:F5" })
   ```

2. If all columns share the same style, pass it as a uniform format:
   ```
   sheets.append_rows({
     spreadsheetId: "...",
     range: "Sheet1!A:F",
     values: [["New item", "Description", ...]],
     format: <format from step 1's formats[0][0]>
   })
   ```

3. If columns have different styles (e.g., column A is bold, column C has a color), use per-cell formatting to preserve column-specific styles:
   ```
   sheets.append_rows({
     spreadsheetId: "...",
     range: "Sheet1!A:F",
     values: [["New item", "Description", ...]],
     formats: [<formats[0] from step 1>]
   })
   ```

The `read_formatting` response returns normalized CellFormat objects that can be passed directly to write/append/format actions.

**Key rule:** When appending to a table, copy the format from the last data row — not the header or a section divider.

### Color Reference

Colors use RGB floats from 0 to 1. Common values:

| Color | Value |
|-------|-------|
| White | `{ red: 1, green: 1, blue: 1 }` |
| Black | `{ red: 0, green: 0, blue: 0 }` |
| Light gray (subtle bg) | `{ red: 0.95, green: 0.95, blue: 0.95 }` |
| Medium gray (borders) | `{ red: 0.7, green: 0.7, blue: 0.7 }` |
| Dark gray (header bg) | `{ red: 0.2, green: 0.2, blue: 0.2 }` |
| Light green | `{ red: 0.85, green: 0.95, blue: 0.85 }` |
| Light blue | `{ red: 0.85, green: 0.92, blue: 1 }` |
| Light yellow | `{ red: 1, green: 0.97, blue: 0.85 }` |
| Red (error/alert) | `{ red: 0.9, green: 0.2, blue: 0.2 }` |
| Green (success) | `{ red: 0.2, green: 0.66, blue: 0.33 }` |
| Blue (links/accent) | `{ red: 0.16, green: 0.38, blue: 0.71 }` |
| White text | `foregroundColor: { red: 1, green: 1, blue: 1 }` |

### Creating Well-Formatted Spreadsheets

**Professional header row:**
```
sheets.write_range({
  spreadsheetId: "...",
  range: "Sheet1!A1:D1",
  values: [["Name", "Role", "Status", "Score"]],
  format: {
    backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
    textFormat: {
      bold: true,
      foregroundColor: { red: 1, green: 1, blue: 1 },
      fontSize: 11
    },
    horizontalAlignment: "LEFT",
    borders: {
      bottom: { style: "SOLID_MEDIUM", color: { red: 0.4, green: 0.4, blue: 0.4 } }
    }
  }
})
```

**Section divider row** (dark background spanning all columns):
```
sheets.write_range({
  spreadsheetId: "...",
  range: "Sheet1!A10:D10",
  values: [["SECTION TITLE", "", "", ""]],
  format: {
    backgroundColor: { red: 0.25, green: 0.3, blue: 0.2 },
    textFormat: {
      bold: true,
      foregroundColor: { red: 1, green: 1, blue: 1 },
      fontSize: 11
    }
  }
})
```

**Alternating row colors** for readability:
```
// After writing data rows, apply striped background:
// Odd rows (1, 3, 5...): light gray
sheets.format_cells({
  spreadsheetId: "...",
  range: "Sheet1!A2:D2",
  format: { backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } }
})
// Even rows (2, 4, 6...): white (or skip — white is default)
```

**Standard data table recipe:**
1. Write header row with formatting (bold, dark bg, white text, bottom border)
2. Write data rows with `write_range` (values only or with per-row alternating colors)
3. Optionally apply a bottom border on the last data row to close the table

### Formatting Properties Reference

**CellFormat fields:**

| Property | Type | Example |
|----------|------|---------|
| `backgroundColor` | Color | `{ red: 0.95, green: 0.95, blue: 0.95 }` |
| `textFormat.bold` | boolean | `true` |
| `textFormat.italic` | boolean | `true` |
| `textFormat.strikethrough` | boolean | `true` |
| `textFormat.underline` | boolean | `true` |
| `textFormat.fontSize` | number | `12` |
| `textFormat.fontFamily` | string | `"Arial"` |
| `textFormat.foregroundColor` | Color | `{ red: 0, green: 0, blue: 0 }` |
| `horizontalAlignment` | enum | `"LEFT"`, `"CENTER"`, `"RIGHT"` |
| `verticalAlignment` | enum | `"TOP"`, `"MIDDLE"`, `"BOTTOM"` |
| `wrapStrategy` | enum | `"OVERFLOW_CELL"`, `"CLIP"`, `"WRAP"` |
| `numberFormat.type` | enum | `"NUMBER"`, `"CURRENCY"`, `"PERCENT"`, `"DATE"` |
| `numberFormat.pattern` | string | `"#,##0.00"`, `"yyyy-mm-dd"` |
| `borders.top` | Border | `{ style: "SOLID", color: { red: 0 } }` |
| `borders.bottom` | Border | `{ style: "SOLID_MEDIUM" }` |
| `borders.left` | Border | `{ style: "DASHED" }` |
| `borders.right` | Border | `{ style: "DOUBLE" }` |

**Border styles:** `NONE`, `SOLID`, `SOLID_MEDIUM`, `SOLID_THICK`, `DASHED`, `DOTTED`, `DOUBLE`

### Merge Coordinates

Merges use 0-based row and column indices (not A1 notation):
- Column A = 0, B = 1, ..., Z = 25, AA = 26
- Row 1 = 0, Row 2 = 1, etc.
- `endRowIndex` and `endColumnIndex` are exclusive (same as Python slice notation)

Example: merge A1:C1 on the first sheet:
```
{ sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 }
```

### Formatting Best Practices

- **Always read before writing to styled sheets.** Use `read_formatting` on a nearby row and pass the result to `write_range` or `append_rows`.
- **Use `format` (uniform) when all cells share the same style.** Use `formats` (per-cell) when columns have different formatting.
- **Only set properties you intend to change.** Omitted properties are preserved — you don't need to specify every field.
- **For borders, set one side only.** The cell below doesn't also need a `top` border if the cell above has a `bottom` border.
- **Use `write_range` with formatting for one-call writes.** This avoids a window where data appears without styling.
```

- [ ] **Step 2: Verify the skill file is well-formed**

Run: `head -5 packages/plugin-google-sheets/skills/google-sheets.md`
Expected: frontmatter is intact

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-google-sheets/skills/google-sheets.md
git commit -m "docs(sheets): add comprehensive formatting guide to skill doc"
```

### Task 10: Regenerate plugin registries

**Files:**
- Modify: `packages/worker/src/plugins/content-registry.ts` (auto-generated)

- [ ] **Step 1: Regenerate registries**

Run: `make generate-registries`
Expected: success, content-registry.ts updated with new skill content

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/plugins/content-registry.ts packages/worker/src/integrations/packages.ts
git commit -m "chore: regenerate plugin registries for sheets formatting"
```
