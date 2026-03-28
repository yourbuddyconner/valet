# Google Sheets Formatting Support — Design Spec

## Problem

The Sheets plugin only handles cell values. When the agent adds or edits rows in a styled spreadsheet, the new rows appear unstyled — no background colors, no bold text, no borders. This breaks visual continuity and requires manual cleanup.

The agent also can't create well-formatted spreadsheets from scratch.

## Solution

Add formatting read/write capabilities through two new actions and optional formatting parameters on two existing actions.

## Scope

**In scope:** Cell formatting (colors, text styles, borders, alignment, number formats, wrapping), cell merges, skill documentation for formatting patterns.

**Out of scope:** Conditional formatting rules, charts, images, data validation, pivot tables, protected ranges, filters, named ranges. These are separate features that can be added later.

## New Actions

### `sheets.read_formatting`

**Risk:** low

Reads cell formatting metadata for a given range. Returns a structured grid of format objects that mirrors the cell layout, plus any merge regions that overlap the range.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `spreadsheetId` | string | yes | Spreadsheet ID |
| `range` | string | yes | A1 notation range to inspect |

**API call:** `GET /v4/spreadsheets/{id}?ranges={range}&fields=sheets.properties.sheetId,sheets.properties.title,sheets.data.rowData.values.userEnteredFormat,sheets.merges`

**Response shape:**

```typescript
{
  success: true,
  data: {
    range: string,
    formats: CellFormat[][],  // 2D grid matching cell layout
    merges: Merge[],          // merge regions overlapping the range
  }
}
```

**CellFormat type:**

```typescript
interface CellFormat {
  backgroundColor?: Color,        // { red, green, blue, alpha } — 0-1 floats
  textFormat?: {
    bold?: boolean,
    italic?: boolean,
    strikethrough?: boolean,
    underline?: boolean,
    fontSize?: number,
    fontFamily?: string,
    foregroundColor?: Color,
  },
  horizontalAlignment?: 'LEFT' | 'CENTER' | 'RIGHT',
  verticalAlignment?: 'TOP' | 'MIDDLE' | 'BOTTOM',
  wrapStrategy?: 'OVERFLOW_CELL' | 'CLIP' | 'WRAP',
  numberFormat?: {
    type: 'TEXT' | 'NUMBER' | 'PERCENT' | 'CURRENCY' | 'DATE' | 'TIME' | 'DATE_TIME' | 'SCIENTIFIC',
    pattern?: string,           // e.g., "#,##0.00", "yyyy-mm-dd"
  },
  borders?: {
    top?: Border,
    bottom?: Border,
    left?: Border,
    right?: Border,
  },
}

interface Color {
  red?: number,    // 0-1
  green?: number,  // 0-1
  blue?: number,   // 0-1
  alpha?: number,  // 0-1, defaults to 1
}

interface Border {
  style: 'NONE' | 'SOLID' | 'SOLID_MEDIUM' | 'SOLID_THICK' | 'DASHED' | 'DOTTED' | 'DOUBLE',
  color?: Color,
}

interface Merge {
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
  sheetId: number,
}
```

Empty cells with no formatting return `{}`. The agent uses this output to understand what styles exist so it can replicate them when writing new data.

### `sheets.format_cells`

**Risk:** medium

Applies formatting to a range. Accepts either a single format object (applied uniformly to every cell in the range) or a 2D array of per-cell format objects.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `spreadsheetId` | string | yes | Spreadsheet ID |
| `range` | string | yes | A1 notation range to format |
| `format` | CellFormat | no | Single format applied to all cells in range |
| `formats` | CellFormat[][] | no | Per-cell formatting grid (must match range dimensions) |
| `merges` | Merge[] | no | Merge regions to apply |
| `unmerge` | boolean | no | If true, unmerge all cells in range before applying |

One of `format` or `formats` must be provided (unless only merging/unmerging).

**API calls:**

- Uniform formatting: `batchUpdate` with `repeatCellRequest` — sets the same format on every cell. The `fields` mask is built dynamically from which format properties are present, so only specified properties are overwritten.
- Per-cell formatting: `batchUpdate` with `updateCellsRequest` — sets individual cell formats. Each cell's `fields` mask covers only its specified properties.
- Merges: `batchUpdate` with `mergeCellsRequest` (type: `MERGE_ALL`).
- Unmerge: `batchUpdate` with `unmergeCellsRequest`.

Multiple requests are batched into a single `batchUpdate` call.

**Response:**

```typescript
{
  success: true,
  data: {
    updatedRange: string,
    mergesApplied: number,
  }
}
```

## Modified Actions

### `sheets.write_range` — optional formatting

**New optional parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `format` | CellFormat | no | Single format applied to all written cells |
| `formats` | CellFormat[][] | no | Per-cell formatting (must match `values` dimensions) |

When formatting is provided, the action uses `batchUpdate` with `updateCellsRequest` instead of the values-only PUT endpoint. Each cell carries both its value and its format. When formatting is omitted, behavior is unchanged — uses the existing `PUT /values/{range}` endpoint.

### `sheets.append_rows` — optional formatting

Same new optional parameters as `write_range`.

When formatting is provided, the action takes a two-step approach (the values-only append endpoint doesn't support formatting):
1. Calls the append endpoint in dry-run mode (`includeValuesInResponse=false`) or reads the sheet metadata to determine the next empty row after the specified range.
2. Uses `batchUpdate` with `updateCellsRequest` targeting the computed start row (via `GridCoordinate` start field), setting both values and formats atomically.

Note: This two-step approach has a small race window — another writer could insert a row between the row discovery and the write. This is acceptable for the agent use case (single writer).

When formatting is omitted, behavior is unchanged — uses the existing append endpoint.

## Implementation Notes

### Fields mask construction

The Google Sheets API uses a `fields` parameter to control which format properties are written. The mask uses comma-separated dotted paths relative to the `CellData` object. If the agent sends `{ backgroundColor: ..., textFormat: { bold: true } }`, the fields mask must be:

```
userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold
```

Without the correct mask, unspecified properties get cleared. Build the mask dynamically by walking the format object keys:
- Top-level keys map to `userEnteredFormat.{key}` (e.g., `userEnteredFormat.backgroundColor`)
- Nested keys map to dotted paths (e.g., `userEnteredFormat.textFormat.bold`)
- Border sides map to `userEnteredFormat.borders.top`, `userEnteredFormat.borders.bottom`, etc.

For `repeatCellRequest`, the `fields` parameter is relative to `cell` (i.e., `CellData`), so the paths above are correct. For `updateCellsRequest`, the `fields` parameter works the same way — each cell row carries its own format and the mask applies uniformly.

This is the most error-prone part of the implementation. Test it carefully with partial format objects.

### Color handling

The Google Sheets API has two color fields: `backgroundColor`/`foregroundColor` (plain `Color` objects) and `backgroundColorStyle`/`foregroundColorStyle` (newer `ColorStyle` wrappers that support theme colors). The plain `Color` fields are deprecated but universally supported and simpler.

**Design decision:** Use the plain `Color` fields (`backgroundColor`, `foregroundColor`) for both reading and writing. On read, normalize the response: if only `*Style` fields are present, extract the `rgbColor` from them and return it as the plain `Color` field. This keeps the agent-facing API simple (just `{ red, green, blue }` objects) while handling cells formatted by modern clients.

The action should accept 0-1 float RGB values directly (no hex conversion). The skill doc should provide common color values as ready-to-use objects so the agent doesn't have to compute float values.

### Merge coordinates

The Sheets API uses 0-based row/column indices for merges, not A1 notation. The `read_formatting` action returns merges in this format. The `format_cells` action accepts them in this format. The skill doc should explain the mapping (A=0, B=1, row 1=0, etc.).

### batchUpdate request ordering

When `write_range` or `append_rows` send both values and formatting, they should be a single `updateCellsRequest` — not separate value + format requests. This is atomic and avoids the "unstyled data" window.

## Skill Documentation Update

The `google-sheets.md` skill file gets a comprehensive formatting section. This is critical — good guidance here directly determines whether the agent produces well-styled output.

### Section: Reading & Matching Existing Formatting

Teach the pattern for maintaining visual continuity:

```
When editing a spreadsheet that already has styling:
1. Before writing data, read formatting from a reference row
   (usually the row above where you're inserting, or a representative data row)
2. Pass that formatting when writing new rows
3. For section headers, read formatting from an existing section header row
```

Provide a concrete example:
```
To append rows that match existing styling:
1. sheets.read_formatting({ spreadsheetId, range: "Sheet1!A5:F5" })
   → returns the format of row 5 (a styled data row)
   → formats[0] is an array of CellFormat objects, one per column

2. If all columns share the same style, use the uniform format:
   sheets.append_rows({
     spreadsheetId,
     range: "Sheet1!A:F",
     values: [["New item", "Description", ...]],
     format: formats[0][0]  // single format applied to all cells
   })

3. If columns have different styles (e.g., col A is bold, col C is colored),
   use per-cell formatting to preserve column-specific styles:
   sheets.append_rows({
     spreadsheetId,
     range: "Sheet1!A:F",
     values: [["New item", "Description", ...]],
     formats: [formats[0]]  // row array preserving per-column styles
   })
```

The `read_formatting` response returns normalized CellFormat objects (plain Color fields, no deprecated *Style wrappers), so the output can be passed directly to write/append/format actions.

### Section: Common Color Reference

Provide a lookup table of colors the agent can use without guessing:

| Color | RGB Object |
|-------|-----------|
| White | `{ red: 1, green: 1, blue: 1 }` |
| Black | `{ red: 0, green: 0, blue: 0 }` |
| Light gray (background) | `{ red: 0.95, green: 0.95, blue: 0.95 }` |
| Dark gray (header bg) | `{ red: 0.2, green: 0.2, blue: 0.2 }` |
| Light green (highlight) | `{ red: 0.85, green: 0.95, blue: 0.85 }` |
| Light blue (highlight) | `{ red: 0.85, green: 0.92, blue: 1 }` |
| Light yellow (highlight) | `{ red: 1, green: 0.97, blue: 0.85 }` |
| Red (error/alert) | `{ red: 0.9, green: 0.2, blue: 0.2 }` |
| Green (success) | `{ red: 0.2, green: 0.66, blue: 0.33 }` |
| Blue (link/accent) | `{ red: 0.16, green: 0.38, blue: 0.71 }` |

### Section: Creating Well-Formatted Spreadsheets

Recipes for building good-looking sheets from scratch:

**Standard data table:**
```
1. Write header row with values
2. Format header row: bold, dark background, white text, bottom border
3. Write data rows
4. Optionally apply alternating row colors for readability
5. Set column widths if needed (via format_cells on column ranges)
```

**Header row recipe:**
```
format: {
  backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
  textFormat: {
    bold: true,
    foregroundColor: { red: 1, green: 1, blue: 1 },
    fontSize: 11,
  },
  horizontalAlignment: "LEFT",
  borders: {
    bottom: { style: "SOLID_MEDIUM", color: { red: 0.4, green: 0.4, blue: 0.4 } }
  }
}
```

**Section divider row recipe** (like "DOCUMENTATION & SOLUTIONS" in the screenshot):
```
format: {
  backgroundColor: { red: 0.25, green: 0.3, blue: 0.2 },
  textFormat: {
    bold: true,
    foregroundColor: { red: 1, green: 1, blue: 1 },
    fontSize: 11,
  },
}
```

**Alternating row colors:**
```
For each pair of rows:
  - Even rows: no background (or white)
  - Odd rows: light gray background { red: 0.95, green: 0.95, blue: 0.95 }
Apply via format_cells with per-row format arrays.
```

### Section: Formatting Best Practices

- Always read existing formatting before writing to a styled sheet. Match the surrounding cells.
- When appending to a table, copy the format from the last data row — not the header or section divider.
- Use `format` (uniform) when all cells in a range share the same style. Use `formats` (per-cell) when cells differ (e.g., some columns are bold, others aren't).
- The `fields` mask controls what gets overwritten. Only specify properties you intend to change — omitted properties are preserved.
- For borders, you usually only need to set them on one side. The cell below doesn't also need a `top` border if the cell above has a `bottom` border.

## Testing

- Read formatting from a richly styled spreadsheet, verify the returned format objects are accurate.
- Write values + formatting in a single `write_range` call, verify both appear.
- Append rows with formatting copied from an existing row, verify visual match.
- Apply formatting to an existing range without changing values, verify values are preserved.
- Test partial format objects (only backgroundColor, only bold) to verify the fields mask doesn't clear other properties.
- Test merge and unmerge operations.
