const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

/** Stateless authenticated fetch against the Drive API v3. */
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

/** Stateless authenticated fetch against the Drive upload endpoint. */
export async function driveUploadFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${DRIVE_UPLOAD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });
}

/** Build a multipart/related body for file creation with metadata + content. */
export function buildMultipartBody(
  metadata: Record<string, unknown>,
  content: string,
  contentType: string,
): { body: string; boundary: string } {
  const boundary = '----ValetDriveBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const parts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`,
    `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${content}`,
    `--${boundary}--`,
  ];
  return { body: parts.join('\r\n'), boundary };
}

/** Check if a MIME type is a Google Workspace document type. */
export function isGoogleWorkspaceMimeType(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.');
}

/** Check if a MIME type is text-based and safe to read as string. */
export function isTextMimeType(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  const textTypes = [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/x-sh',
    'application/sql',
    'application/graphql',
    'application/xhtml+xml',
    'application/ld+json',
    'application/manifest+json',
  ];
  return textTypes.includes(mimeType);
}

/** Map Google Workspace MIME types to their best text export format. */
export function getExportMimeType(googleMimeType: string): string | null {
  const exportMap: Record<string, string> = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
    'application/vnd.google-apps.drawing': 'image/svg+xml',
    'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
  };
  return exportMap[googleMimeType] || null;
}
