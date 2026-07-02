import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeSheetsAction } from '../sheets-actions.js';

describe('executeSheetsAction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a structured Sheets API error when clear_range receives a 401', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Request had invalid authentication credentials.' } }),
      { status: 401, statusText: 'Unauthorized' },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeSheetsAction(
      'sheets.clear_range',
      { spreadsheetId: 'sheet-1', range: 'Tasks!A1:D6' },
      { credentials: { access_token: 'stale-token' }, userId: 'user-1' },
    );

    expect(result).toEqual({
      success: false,
      error: 'Sheets API 401: Request had invalid authentication credentials.',
    });
  });
});
