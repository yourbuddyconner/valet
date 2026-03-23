import type { PromptAttachment } from '../../durable-objects/runner-link.js';

export const MAX_PROMPT_ATTACHMENTS = 8;
export const MAX_PROMPT_ATTACHMENT_URL_LENGTH = 12_000_000;
/** Total base64 across all attachments — safety cap below 32 MiB WS limit. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25_000_000;

/** MIME type prefixes that are accepted for prompt attachments. */
const SUPPORTED_MIME_PREFIXES = ['image/', 'audio/'] as const;
/** Specific non-prefix MIME types that are accepted. */
const SUPPORTED_MIME_EXACT = new Set(['application/pdf']);

/** Human-readable list of supported file types for error messages. */
export const SUPPORTED_FILE_TYPES_DESCRIPTION = 'images, audio, and PDFs';

// ─── Magic number → MIME detection ──────────────────────────────────────────

interface MagicSignature {
  offset: number;
  bytes: number[];
  mime: string;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  // Images
  { offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47], mime: 'image/png' },
  { offset: 0, bytes: [0xFF, 0xD8, 0xFF], mime: 'image/jpeg' },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' }, // RIFF header (check WEBP after)
  // PDF
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' }, // %PDF
  // Audio
  { offset: 0, bytes: [0x49, 0x44, 0x33], mime: 'audio/mpeg' }, // ID3 tag
  { offset: 0, bytes: [0xFF, 0xFB], mime: 'audio/mpeg' }, // MP3 frame sync
  { offset: 0, bytes: [0xFF, 0xF3], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xFF, 0xF2], mime: 'audio/mpeg' },
  { offset: 0, bytes: [0x4F, 0x67, 0x67, 0x53], mime: 'audio/ogg' }, // OggS
  { offset: 0, bytes: [0x66, 0x4C, 0x61, 0x43], mime: 'audio/flac' }, // fLaC
];

/**
 * Detect MIME type from the first few bytes of file content.
 * Returns the detected MIME or null if no signature matches.
 */
function detectMimeFromBytes(base64Data: string): string | null {
  // Decode enough bytes for signature detection (first 16 bytes is plenty)
  const chunk = base64Data.slice(0, 24); // 24 base64 chars = 18 bytes
  let bytes: Uint8Array;
  try {
    const binary = atob(chunk);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
  } catch {
    return null;
  }

  for (const sig of MAGIC_SIGNATURES) {
    if (bytes.length < sig.offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (bytes[sig.offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      // RIFF could be WEBP or WAV — check bytes 8-11
      if (sig.mime === 'image/webp') {
        if (bytes.length >= 12) {
          const subtype = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
          if (subtype === 'WAVE') return 'audio/wav';
          if (subtype === 'WEBP') return 'image/webp';
        }
        return 'application/octet-stream'; // can't determine RIFF subtype
      }
      return sig.mime;
    }
  }
  return null;
}

/** Check whether a MIME type is in the supported set. */
function isSupportedMime(mime: string): boolean {
  if (SUPPORTED_MIME_EXACT.has(mime)) return true;
  return SUPPORTED_MIME_PREFIXES.some(prefix => mime.startsWith(prefix));
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function parseBase64DataUrl(url: string): string | null {
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) return null;
  const data = url.slice(commaIndex + 1).replace(/\s+/g, '');
  return data.length > 0 ? data : null;
}

export interface SanitizeResult {
  attachments: PromptAttachment[];
  /** File types that were rejected (for error reporting). */
  rejectedTypes: string[];
}

/**
 * Validate and normalize prompt attachments.
 * Sniffs actual MIME type from file bytes when the declared type doesn't match.
 * Returns accepted attachments and any rejected file types.
 */
export function sanitizePromptAttachments(input: unknown): SanitizeResult {
  if (!Array.isArray(input)) return { attachments: [], rejectedTypes: [] };
  const result: PromptAttachment[] = [];
  const rejectedTypes: string[] = [];

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'file') continue;
    if (typeof record.mime !== 'string' || typeof record.url !== 'string') continue;

    let mime = record.mime.trim().toLowerCase();
    const url = record.url.trim();
    if (!url.startsWith('data:') || !url.includes(';base64,')) continue;
    if (url.length > MAX_PROMPT_ATTACHMENT_URL_LENGTH) continue;

    // Sniff actual MIME from file bytes — overrides declared MIME if detected
    let mimeWasCorrected = false;
    const base64Data = parseBase64DataUrl(url);
    if (base64Data) {
      const detected = detectMimeFromBytes(base64Data);
      if (detected && detected !== mime) {
        console.log(`[prompt-validation] MIME corrected: declared=${mime} actual=${detected}`);
        mime = detected;
        mimeWasCorrected = true;
      }
    }

    if (!isSupportedMime(mime)) {
      const ext = typeof record.filename === 'string'
        ? record.filename.split('.').pop() || mime
        : mime;
      rejectedTypes.push(ext);
      continue;
    }

    const filename = typeof record.filename === 'string' ? record.filename.slice(0, 255) : undefined;
    const finalUrl = mimeWasCorrected ? `data:${mime};base64,${base64Data}` : url;
    result.push({ type: 'file', mime, url: finalUrl, filename });
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
  return { attachments: capped, rejectedTypes };
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
    } else if (attachment.mime === 'application/pdf') {
      // PDFs are passed through as file attachments — text extraction happens in the Runner
      parts.push({
        type: 'file',
        data,
        mimeType: attachment.mime,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
    }
  }
  return parts;
}

export function parseQueuedPromptAttachments(raw: unknown): SanitizeResult {
  if (typeof raw !== 'string' || !raw) return { attachments: [], rejectedTypes: [] };
  try {
    return sanitizePromptAttachments(JSON.parse(raw));
  } catch {
    return { attachments: [], rejectedTypes: [] };
  }
}
