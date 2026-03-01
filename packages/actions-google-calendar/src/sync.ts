import type { SyncResult, SyncError } from '@agent-ops/shared';
import type { SyncSource, IntegrationCredentials, SyncOptions } from '@agent-ops/sdk';
import { calendarFetch } from './api.js';

interface GoogleCalendar {
  id: string;
  summary: string;
  description?: string;
  timeZone: string;
  primary?: boolean;
  accessRole: string;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
}

function syncError(entity: string, message: string, code: string): SyncError {
  return { entity, message, code };
}

async function syncCalendars(token: string): Promise<SyncResult> {
  try {
    const calendars: GoogleCalendar[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ maxResults: '250' });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await calendarFetch(`/users/me/calendarList?${params}`, token);
      if (!res.ok) {
        return {
          success: false, recordsSynced: 0,
          errors: [syncError('calendars', `Failed to list calendars: ${res.status}`, 'FETCH_FAILED')],
          completedAt: new Date(),
        };
      }

      const data = (await res.json()) as { items: GoogleCalendar[]; nextPageToken?: string };
      calendars.push(...(data.items || []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    return { success: true, recordsSynced: calendars.length, errors: [], completedAt: new Date() };
  } catch (error) {
    return {
      success: false, recordsSynced: 0,
      errors: [syncError('calendars', String(error), 'SYNC_ERROR')],
      completedAt: new Date(),
    };
  }
}

async function syncEvents(token: string): Promise<SyncResult> {
  try {
    const now = new Date();
    const timeMin = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const timeMax = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      maxResults: '100',
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
    });

    const res = await calendarFetch(`/calendars/primary/events?${params}`, token);
    if (!res.ok) {
      return {
        success: false, recordsSynced: 0,
        errors: [syncError('events', `Failed to list events: ${res.status}`, 'FETCH_FAILED')],
        completedAt: new Date(),
      };
    }

    const data = (await res.json()) as { items: GoogleEvent[] };
    return { success: true, recordsSynced: (data.items || []).length, errors: [], completedAt: new Date() };
  } catch (error) {
    return {
      success: false, recordsSynced: 0,
      errors: [syncError('events', String(error), 'SYNC_ERROR')],
      completedAt: new Date(),
    };
  }
}

export const googleCalendarSync: SyncSource = {
  async sync(credentials: IntegrationCredentials, options: SyncOptions): Promise<SyncResult> {
    const token = credentials.access_token || '';
    if (!token) {
      return {
        success: false, recordsSynced: 0,
        errors: [syncError('auth', 'Invalid credentials', 'INVALID_CREDENTIALS')],
        completedAt: new Date(),
      };
    }

    const entities = options.entities || ['calendars', 'events'];
    let totalSynced = 0;
    const errors: SyncError[] = [];

    if (entities.includes('calendars')) {
      const result = await syncCalendars(token);
      totalSynced += result.recordsSynced;
      errors.push(...result.errors);
    }

    if (entities.includes('events')) {
      const result = await syncEvents(token);
      totalSynced += result.recordsSynced;
      errors.push(...result.errors);
    }

    return {
      success: errors.length === 0,
      recordsSynced: totalSynced,
      errors,
      completedAt: new Date(),
    };
  },
};
