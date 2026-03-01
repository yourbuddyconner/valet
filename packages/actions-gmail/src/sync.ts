import type { SyncResult, SyncError } from '@agent-ops/shared';
import type { SyncSource, IntegrationCredentials, SyncOptions } from '@agent-ops/sdk';
import { gmailFetch, decodeBase64Url } from './api.js';

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  payload?: {
    mimeType: string;
    filename?: string;
    headers: Array<{ name: string; value: string }>;
    body: { attachmentId?: string; size: number; data?: string };
    parts?: GmailMessage['payload'][];
  };
}

interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
}

function syncError(entity: string, message: string, code: string): SyncError {
  return { entity, message, code };
}

async function syncMessages(token: string, options: SyncOptions): Promise<SyncResult> {
  try {
    const params = new URLSearchParams({
      maxResults: '50',
      includeSpamTrash: 'false',
    });
    if (options.cursor) params.set('pageToken', options.cursor);

    const listRes = await gmailFetch(`/users/me/messages?${params}`, token);
    if (!listRes.ok) {
      return {
        success: false, recordsSynced: 0,
        errors: [syncError('messages', `Failed to list messages: ${listRes.status}`, 'FETCH_FAILED')],
        completedAt: new Date(),
      };
    }

    const listData = (await listRes.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    };

    if (!listData.messages) {
      return { success: true, recordsSynced: 0, errors: [], completedAt: new Date() };
    }

    let fetched = 0;
    for (const msg of listData.messages.slice(0, 20)) {
      const fullRes = await gmailFetch(`/users/me/messages/${msg.id}?format=full`, token);
      if (fullRes.ok) fetched++;
    }

    return {
      success: true,
      recordsSynced: fetched,
      errors: [],
      nextCursor: listData.nextPageToken,
      completedAt: new Date(),
    };
  } catch (error) {
    return {
      success: false, recordsSynced: 0,
      errors: [syncError('messages', String(error), 'SYNC_ERROR')],
      completedAt: new Date(),
    };
  }
}

async function syncLabels(token: string): Promise<SyncResult> {
  try {
    const res = await gmailFetch('/users/me/labels', token);
    if (!res.ok) {
      return {
        success: false, recordsSynced: 0,
        errors: [syncError('labels', `Failed to fetch labels: ${res.status}`, 'FETCH_FAILED')],
        completedAt: new Date(),
      };
    }

    const data = (await res.json()) as { labels: GmailLabel[] };
    return { success: true, recordsSynced: data.labels?.length || 0, errors: [], completedAt: new Date() };
  } catch (error) {
    return {
      success: false, recordsSynced: 0,
      errors: [syncError('labels', String(error), 'SYNC_ERROR')],
      completedAt: new Date(),
    };
  }
}

export const gmailSync: SyncSource = {
  async sync(credentials: IntegrationCredentials, options: SyncOptions): Promise<SyncResult> {
    const token = credentials.access_token || '';
    if (!token) {
      return {
        success: false, recordsSynced: 0,
        errors: [syncError('auth', 'Invalid credentials', 'INVALID_CREDENTIALS')],
        completedAt: new Date(),
      };
    }

    const entities = options.entities || ['messages'];
    let totalSynced = 0;
    const errors: SyncError[] = [];

    if (entities.includes('messages')) {
      const result = await syncMessages(token, options);
      totalSynced += result.recordsSynced;
      errors.push(...result.errors);
    }

    if (entities.includes('labels')) {
      const result = await syncLabels(token);
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
