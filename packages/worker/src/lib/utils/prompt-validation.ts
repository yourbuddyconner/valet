import type { PromptAttachment } from '../../durable-objects/runner-link.js';

export const MAX_PROMPT_ATTACHMENTS = 8;
export const MAX_PROMPT_ATTACHMENT_URL_LENGTH = 90_000_000;
/** Total base64 across all attachments. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 90_000_000;

/** MIME type prefixes that are accepted for prompt attachments. */
const SUPPORTED_MIME_PREFIXES = ['image/', 'audio/', 'text/'] as const;
/** Specific non-prefix MIME types that are accepted. */
const SUPPORTED_MIME_EXACT = new Set([
  'application/pdf',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/graphql',
]);

/** Human-readable list of supported file types for error messages. */
export const SUPPORTED_FILE_TYPES_DESCRIPTION = 'images, audio, PDFs, and text files';

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

// ─── Extension → MIME resolution for octet-stream / unknown types ──────────

const TEXT_FILE_EXTENSIONS: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  log: 'text/plain', env: 'text/plain', cfg: 'text/plain',
  ini: 'text/plain', conf: 'text/plain',
  json: 'application/json', xml: 'application/xml',
  yaml: 'application/x-yaml', yml: 'application/x-yaml',
  toml: 'application/toml', sql: 'application/sql',
  graphql: 'application/graphql', gql: 'application/graphql',
  html: 'text/html', htm: 'text/html', css: 'text/css',
  scss: 'text/x-scss', less: 'text/x-less', svg: 'text/xml',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  jsx: 'text/javascript', ts: 'text/x-typescript', tsx: 'text/x-typescript',
  py: 'text/x-python', pyi: 'text/x-python',
  go: 'text/x-go', rs: 'text/x-rust', c: 'text/x-c', cpp: 'text/x-c++',
  h: 'text/x-c', hpp: 'text/x-c++', cs: 'text/x-csharp',
  java: 'text/x-java', kt: 'text/x-kotlin', scala: 'text/x-scala',
  clj: 'text/x-clojure', groovy: 'text/x-groovy',
  rb: 'text/x-ruby', php: 'text/x-php', swift: 'text/x-swift',
  r: 'text/x-r', lua: 'text/x-lua', pl: 'text/x-perl',
  ex: 'text/x-elixir', exs: 'text/x-elixir',
  hs: 'text/x-haskell', ml: 'text/x-ocaml',
  nim: 'text/x-nim', zig: 'text/x-zig', v: 'text/x-vlang',
  dart: 'text/x-dart',
  sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh',
  fish: 'text/x-sh', ps1: 'text/x-powershell',
  tf: 'text/x-terraform', hcl: 'text/x-terraform',
  dockerfile: 'text/x-dockerfile',
  makefile: 'text/x-makefile', cmake: 'text/x-cmake',
};

function resolveTextMimeFromFilename(filename: string | undefined): string | null {
  if (!filename) return null;
  const dot = filename.lastIndexOf('.');
  if (dot === -1) {
    const lower = filename.toLowerCase();
    return TEXT_FILE_EXTENSIONS[lower] ?? null;
  }
  const ext = filename.slice(dot + 1).toLowerCase();
  return TEXT_FILE_EXTENSIONS[ext] ?? null;
}

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

    // When the declared MIME isn't in the supported set, try resolving from filename
    // extension. Browsers frequently misidentify code files (e.g. .ts → video/mp2t).
    if (!isSupportedMime(mime) && typeof record.filename === 'string') {
      const resolved = resolveTextMimeFromFilename(record.filename);
      if (resolved) {
        console.log(`[prompt-validation] MIME resolved from extension: declared=${mime} filename=${record.filename} resolved=${resolved}`);
        mime = resolved;
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
    } else if (attachment.mime.startsWith('text/') || (SUPPORTED_MIME_EXACT.has(attachment.mime) && attachment.mime !== 'application/pdf')) {
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

export function attachmentPartsForDisplay(attachments: PromptAttachment[]): Array<Record<string, unknown>> {
  return attachmentPartsForMessage(attachments).map((part) => {
    if (part.type !== 'file') return part;
    const { data: _data, ...displayPart } = part;
    return displayPart;
  });
}

export function attachmentsForClientState(attachments: PromptAttachment[]): Array<Record<string, unknown>> {
  return attachments.map((attachment) => {
    const clientAttachment: Record<string, unknown> = {
      type: attachment.type,
      mime: attachment.mime,
    };
    if (attachment.filename !== undefined) {
      clientAttachment.filename = attachment.filename;
    }
    return clientAttachment;
  });
}

export function parseQueuedPromptAttachments(raw: unknown): SanitizeResult {
  if (typeof raw !== 'string' || !raw) return { attachments: [], rejectedTypes: [] };
  try {
    return sanitizePromptAttachments(JSON.parse(raw));
  } catch {
    return { attachments: [], rejectedTypes: [] };
  }
}
