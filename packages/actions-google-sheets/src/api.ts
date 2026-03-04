const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Stateless authenticated fetch against the Sheets API v4. */
export async function sheetsFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${SHEETS_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

/** Build a descriptive error from a failed Sheets API response. */
export async function sheetsError(res: Response): Promise<{ success: false; error: string }> {
  let detail = '';
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    detail = json?.error?.message || body.slice(0, 200);
  } catch {
    detail = res.statusText;
  }
  return { success: false, error: `Sheets API ${res.status}: ${detail}` };
}
