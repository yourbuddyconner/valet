import { describe, it, expect } from 'vitest';
import { buildFieldMask, normalizeFormat, normalizeFormatsResponse } from './formatting.js';

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
