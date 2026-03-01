const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** Stateless authenticated fetch against the Google Calendar API. */
export async function calendarFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}
