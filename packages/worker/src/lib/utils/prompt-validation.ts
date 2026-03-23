import type { PromptAttachment } from '../../durable-objects/runner-link.js';

export const MAX_PROMPT_ATTACHMENTS = 8;
export const MAX_PROMPT_ATTACHMENT_URL_LENGTH = 12_000_000;
/** Total base64 across all attachments — safety cap below 32 MiB WS limit. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25_000_000;

export function parseBase64DataUrl(url: string): string | null {
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) return null;
  const data = url.slice(commaIndex + 1).replace(/\s+/g, '');
  return data.length > 0 ? data : null;
}

export function sanitizePromptAttachments(input: unknown): PromptAttachment[] {
  if (!Array.isArray(input)) return [];
  const result: PromptAttachment[] = [];

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'file') continue;
    if (typeof record.mime !== 'string' || typeof record.url !== 'string') continue;

    const mime = record.mime.trim().toLowerCase();
    const url = record.url.trim();
    if (!mime.startsWith('image/') && !mime.startsWith('audio/')) continue;
    if (!url.startsWith('data:') || !url.includes(';base64,')) continue;
    if (url.length > MAX_PROMPT_ATTACHMENT_URL_LENGTH) continue;

    const filename = typeof record.filename === 'string' ? record.filename.slice(0, 255) : undefined;
    result.push({ type: 'file', mime, url, filename });
    if (result.length >= MAX_PROMPT_ATTACHMENTS) break;
  }

  // Cap total attachment size to stay safely under the 32 MiB WS limit
  let totalLen = 0;
  const capped: PromptAttachment[] = [];
  for (const att of result) {
    totalLen += att.url.length;
    if (totalLen > MAX_TOTAL_ATTACHMENT_BYTES) break;
    capped.push(att);
  }
  return capped;
}

export function attachmentPartsForMessage(attachments: PromptAttachment[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const attachment of attachments) {
    const data = parseBase64DataUrl(attachment.url);
    if (!data) continue;

    if (attachment.mime.startsWith('image/')) {
      parts.push({
        type: 'image',
        data,
        mimeType: attachment.mime,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
    } else if (attachment.mime.startsWith('audio/')) {
      parts.push({
        type: 'audio',
        data,
        mimeType: attachment.mime,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
    }
  }
  return parts;
}

export function parseQueuedPromptAttachments(raw: unknown): PromptAttachment[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    return sanitizePromptAttachments(JSON.parse(raw));
  } catch {
    return [];
  }
}
