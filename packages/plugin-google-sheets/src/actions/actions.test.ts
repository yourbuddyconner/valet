import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { googleSheetsActions } from './actions.js';
import type { ActionContext } from '@valet/sdk';

const mockCtx: ActionContext = {
  credentials: { access_token: 'test-token' },
  userId: 'user-1',
};

describe('sheets.read_formatting', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('calls the correct API endpoint with formatting fields', async () => {
    const mockResponse = {
      sheets: [{
        properties: { sheetId: 0, title: 'Sheet1' },
        data: [{ rowData: [{ values: [{ userEnteredFormat: { backgroundColor: { red: 1, green: 0.95, blue: 0.8 } } }] }] }],
        merges: [],
      }],
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockResponse) });

    const result = await googleSheetsActions.execute('sheets.read_formatting', { spreadsheetId: 'abc123', range: 'Sheet1!A1:A1' }, mockCtx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      range: 'Sheet1!A1:A1',
      formats: [[{ backgroundColor: { red: 1, green: 0.95, blue: 0.8 } }]],
      merges: [],
    });
    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('sheets.data.rowData.values.userEnteredFormat');
    expect(url).toContain('sheets.merges');
  });

  it('normalizes *Style color fields', async () => {
    const mockResponse = {
      sheets: [{
        properties: { sheetId: 0, title: 'Sheet1' },
        data: [{ rowData: [{ values: [{ userEnteredFormat: { backgroundColorStyle: { rgbColor: { red: 0.5, green: 0.5, blue: 0.5 } } } }] }] }],
        merges: [],
      }],
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockResponse) });

    const result = await googleSheetsActions.execute('sheets.read_formatting', { spreadsheetId: 'abc123', range: 'Sheet1!A1:A1' }, mockCtx);
    expect(result.success).toBe(true);
    expect((result.data as any).formats[0][0].backgroundColor).toEqual({ red: 0.5, green: 0.5, blue: 0.5 });
  });
});

describe('sheets.format_cells', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends repeatCellRequest for uniform format', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ replies: [] }) });

    const result = await googleSheetsActions.execute('sheets.format_cells', {
      spreadsheetId: 'abc123', range: 'Sheet1!A1:C3',
      format: { backgroundColor: { red: 1, green: 0, blue: 0 } },
    }, mockCtx);
    expect(result.success).toBe(true);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(body.requests[0]).toHaveProperty('repeatCell');
    expect(body.requests[0].repeatCell.cell.userEnteredFormat.backgroundColor).toEqual({ red: 1, green: 0, blue: 0 });
  });

  it('sends updateCellsRequest for per-cell formats', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ replies: [] }) });

    const result = await googleSheetsActions.execute('sheets.format_cells', {
      spreadsheetId: 'abc123', range: 'Sheet1!A1:B1',
      formats: [[{ textFormat: { bold: true } }, { textFormat: { italic: true } }]],
    }, mockCtx);
    expect(result.success).toBe(true);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(body.requests[0]).toHaveProperty('updateCells');
  });

  it('includes merge requests', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ replies: [] }) });

    const result = await googleSheetsActions.execute('sheets.format_cells', {
      spreadsheetId: 'abc123', range: 'Sheet1!A1:C1',
      format: { textFormat: { bold: true } },
      merges: [{ sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 }],
    }, mockCtx);
    expect(result.success).toBe(true);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(body.requests.some((r: any) => 'mergeCells' in r)).toBe(true);
  });
});

describe('sheets.write_range with formatting', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses values-only PUT when no formatting provided', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ updatedCells: 4 }) });
    const result = await googleSheetsActions.execute('sheets.write_range', {
      spreadsheetId: 'abc123', range: 'Sheet1!A1:B2', values: [['a', 'b'], ['c', 'd']],
    }, mockCtx);
    expect(result.success).toBe(true);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe('PUT');
  });

  it('uses batchUpdate when uniform format provided', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ replies: [] }) });

    const result = await googleSheetsActions.execute('sheets.write_range', {
      spreadsheetId: 'abc123', range: 'Sheet1!A1:B1',
      values: [['Hello', 'World']],
      format: { backgroundColor: { red: 1 } },
    }, mockCtx);
    expect(result.success).toBe(true);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(body.requests[0]).toHaveProperty('updateCells');
    const cells = body.requests[0].updateCells.rows[0].values;
    expect(cells[0].userEnteredValue).toEqual({ stringValue: 'Hello' });
    expect(cells[0].userEnteredFormat).toEqual({ backgroundColor: { red: 1 } });
  });

  it('uses per-cell formats when formats array provided', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ replies: [] }) });

    const result = await googleSheetsActions.execute('sheets.write_range', {
      spreadsheetId: 'abc123', range: 'Sheet1!A1:B1',
      values: [['Hello', 'World']],
      formats: [[{ textFormat: { bold: true } }, { textFormat: { italic: true } }]],
    }, mockCtx);
    expect(result.success).toBe(true);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    const cells = body.requests[0].updateCells.rows[0].values;
    expect(cells[0].userEnteredFormat).toEqual({ textFormat: { bold: true } });
    expect(cells[1].userEnteredFormat).toEqual({ textFormat: { italic: true } });
  });
});

describe('sheets.append_rows with formatting', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses values-only append when no formatting provided', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 } }) });
    const result = await googleSheetsActions.execute('sheets.append_rows', {
      spreadsheetId: 'abc123', range: 'Sheet1!A:D', values: [['a', 'b', 'c', 'd']],
    }, mockCtx);
    expect(result.success).toBe(true);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(':append');
  });

  it('discovers next row and uses batchUpdate when formatting provided', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ values: [['H1', 'H2'], ['R1', 'D1'], ['R2', 'D2']] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ replies: [] }) });

    const result = await googleSheetsActions.execute('sheets.append_rows', {
      spreadsheetId: 'abc123', range: 'Sheet1!A:B',
      values: [['NewRow', 'NewData']],
      format: { backgroundColor: { red: 0.9, green: 0.95, blue: 0.9 } },
    }, mockCtx);
    expect(result.success).toBe(true);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[2][1].body);
    expect(body.requests[0]).toHaveProperty('updateCells');
    expect(body.requests[0].updateCells.start.rowIndex).toBe(3);
  });
});
