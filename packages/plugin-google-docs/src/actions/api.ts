import type { DocsRequest } from './markdown-to-docs.js';

const DOCS_API = 'https://docs.googleapis.com/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/** Authenticated fetch against Google Docs API v1. */
export async function docsFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${DOCS_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

/** Authenticated fetch against Google Drive API v3 (for document discovery). */
export async function driveFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${DRIVE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

const MAX_BATCH_SIZE = 50;

const DELETE_TYPES = new Set(['deleteContentRange']);
const INSERT_TYPES = new Set([
  'insertText',
  'insertTable',
  'insertPageBreak',
  'insertInlineImage',
  'insertSectionBreak',
]);
// Everything else is a format request

/** Build descriptive error from a failed API response. */
export async function apiError(res: Response, api: string): Promise<{ success: false; error: string }> {
  let detail = '';
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    detail = json?.error?.message || body.slice(0, 500);
  } catch {
    detail = res.statusText;
  }
  return { success: false, error: `${api} API ${res.status}: ${detail}` };
}

/**
 * Execute batchUpdate requests in three phases: delete → insert → format.
 * Splits large batches into chunks of MAX_BATCH_SIZE requests max.
 * Returns success/error result.
 */
export async function executeBatchUpdate(
  documentId: string,
  token: string,
  requests: DocsRequest[],
): Promise<{ success: boolean; error?: string }> {
  if (requests.length === 0) {
    return { success: true };
  }

  // Categorize requests into three phases by examining each request's first key
  const deleteRequests: DocsRequest[] = [];
  const insertRequests: DocsRequest[] = [];
  const formatRequests: DocsRequest[] = [];

  for (const req of requests) {
    const key = Object.keys(req)[0];
    if (DELETE_TYPES.has(key)) {
      deleteRequests.push(req);
    } else if (INSERT_TYPES.has(key)) {
      insertRequests.push(req);
    } else {
      formatRequests.push(req);
    }
  }

  // Execute phases in order: delete → insert → format
  const phases = [deleteRequests, insertRequests, formatRequests];

  for (const phaseRequests of phases) {
    // Split each phase into chunks of MAX_BATCH_SIZE
    for (let i = 0; i < phaseRequests.length; i += MAX_BATCH_SIZE) {
      const chunk = phaseRequests.slice(i, i + MAX_BATCH_SIZE);
      const res = await docsFetch(
        `/documents/${documentId}:batchUpdate`,
        token,
        { method: 'POST', body: JSON.stringify({ requests: chunk }) },
      );
      if (!res.ok) {
        return apiError(res, 'Docs batchUpdate');
      }
    }
  }

  return { success: true };
}
