import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { gmailFetch, decodeBase64Url, encodeBase64Url } from './api.js';
import { renderMarkdownToHtml } from './markdown.js';

// ─── Internal Types ──────────────────────────────────────────────────────────

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePayload;
}

interface GmailMessagePayload {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePayload[];
}

interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
}

// ─── Error Helper ─────────────────────────────────────────────────────────────

async function gmailError(res: Response): Promise<ActionResult> {
  let detail = '';
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    detail = json?.error?.message || body.slice(0, 200);
  } catch {
    detail = res.statusText;
  }
  return { success: false, error: `Gmail API ${res.status}: ${detail}` };
}

// ─── MIME Helpers ─────────────────────────────────────────────────────────────

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for any non-ASCII content in headers.
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  // Use encodeBase64Url for the encoded portion; we need standard base64 here
  // so use btoa directly after encoding to UTF-8.
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function buildHtmlBody(markdownBody: string): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<body>',
    renderMarkdownToHtml(markdownBody),
    '</body>',
    '</html>',
  ].join('\n');
}

function createMimeBoundary(parts: string[]): string {
  let boundary = '';
  do {
    boundary = `b1_${globalThis.crypto.randomUUID()}`;
  } while (parts.some((part) => part.includes(boundary)));
  return boundary;
}

export function buildMimeMessage(opts: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
}): string {
  const htmlBody = buildHtmlBody(opts.body);
  const boundary = createMimeBoundary([opts.body, htmlBody]);
  const lines: string[] = [];
  lines.push(`To: ${opts.to.join(', ')}`);
  if (opts.cc && opts.cc.length > 0) lines.push(`Cc: ${opts.cc.join(', ')}`);
  if (opts.bcc && opts.bcc.length > 0) lines.push(`Bcc: ${opts.bcc.join(', ')}`);
  lines.push(`Subject: ${encodeHeader(opts.subject)}`);
  lines.push('MIME-Version: 1.0');
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(opts.body);
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(htmlBody);
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}

function encodeRawMessage(mime: string): string {
  return encodeBase64Url(mime);
}

/** Fetch reply threading headers for a message. */
async function getReplyContext(
  messageId: string,
  token: string,
): Promise<{ threadId: string | undefined; inReplyTo: string | null; references: string | null }> {
  const qs = new URLSearchParams({
    format: 'metadata',
    metadataHeaders: 'Message-Id',
  });
  // metadataHeaders can appear multiple times
  const url = `/users/me/messages/${messageId}?format=metadata&metadataHeaders=Message-Id&metadataHeaders=References&metadataHeaders=Subject`;
  const res = await gmailFetch(url, token);
  if (!res.ok) throw new Error(`Failed to fetch original message: ${res.status}`);
  const msg = (await res.json()) as GmailMessage;
  const headers = msg.payload?.headers ?? [];
  const findHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
  const inReplyTo = findHeader('message-id');
  const origRefs = findHeader('references');
  const references = [origRefs, inReplyTo].filter(Boolean).join(' ') || null;
  return { threadId: msg.threadId ?? undefined, inReplyTo, references };
}

/** Build MIME + base64url raw, resolving threading if replyToMessageId is set. */
async function prepareMimeRequest(
  args: {
    to: string | string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    replyToMessageId?: string;
  },
  token: string,
): Promise<{ raw: string; threadId: string | undefined; toList: string[] }> {
  const toList = Array.isArray(args.to) ? args.to : [args.to];
  let threadId: string | undefined;
  let inReplyTo: string | null = null;
  let references: string | null = null;

  if (args.replyToMessageId) {
    const ctx = await getReplyContext(args.replyToMessageId, token);
    threadId = ctx.threadId;
    inReplyTo = ctx.inReplyTo;
    references = ctx.references;
  }

  const raw = encodeRawMessage(
    buildMimeMessage({ to: toList, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body, inReplyTo, references }),
  );
  return { raw, threadId, toList };
}

// ─── Body Extraction Helpers ──────────────────────────────────────────────────

function extractMessageBody(payload?: GmailMessagePayload): { text: string; html: string } {
  let text = '';
  let html = '';
  if (!payload) return { text, html };
  const walk = (part: GmailMessagePayload) => {
    const mime = part.mimeType ?? '';
    if (mime === 'text/plain' && part.body?.data) text += decodeBase64Url(part.body.data);
    else if (mime === 'text/html' && part.body?.data) html += decodeBase64Url(part.body.data);
    if (part.parts) for (const sub of part.parts) walk(sub);
  };
  walk(payload);
  return { text, html };
}

function findHeaderValue(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function collectAttachments(payload?: GmailMessagePayload): Array<{
  partId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
}> {
  const out: ReturnType<typeof collectAttachments> = [];
  if (!payload) return out;
  const walk = (part: GmailMessagePayload) => {
    if (part.filename && part.body?.attachmentId) {
      out.push({
        partId: part.partId ?? null,
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId ?? null,
      });
    }
    if (part.parts) for (const sub of part.parts) walk(sub);
  };
  walk(payload);
  return out;
}

function extractDomain(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const match = fromHeader.match(/<?([^@<>\s]+)@([^>\s]+)>?/);
  return match ? match[2].toLowerCase() : null;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max) + '…';
}

// ─── Output Schemas (shared) ────────────────────────────────────────────────

const gmailHeadersSchema = {
  type: 'object',
  properties: {
    from: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    cc: { type: ['string', 'null'] },
    bcc: { type: ['string', 'null'] },
    subject: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    messageIdHeader: { type: ['string', 'null'], description: 'The Message-Id RFC header (not the Gmail id)' },
  },
} satisfies Record<string, unknown>;

const gmailMessageListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    threadId: { type: 'string' },
    labelIds: { type: 'array', items: { type: 'string' } },
    snippet: { type: 'string' },
    from: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    subject: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
  },
} satisfies Record<string, unknown>;

const gmailDraftListItemSchema = {
  type: 'object',
  properties: {
    draftId: { type: 'string' },
    messageId: { type: ['string', 'null'] },
    threadId: { type: ['string', 'null'] },
    snippet: { type: 'string' },
    to: { type: ['string', 'null'] },
    cc: { type: ['string', 'null'] },
    subject: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
  },
} satisfies Record<string, unknown>;

const gmailAttachmentSchema = {
  type: 'object',
  properties: {
    attachmentId: { type: 'string' },
    filename: { type: 'string' },
    mimeType: { type: 'string' },
    size: { type: 'number' },
  },
} satisfies Record<string, unknown>;

const gmailTriageMessageSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    threadId: { type: 'string' },
    from: { type: ['string', 'null'] },
    domain: { type: ['string', 'null'], description: 'Extracted sender domain' },
    to: { type: ['string', 'null'] },
    subject: { type: 'string' },
    date: { type: ['string', 'null'] },
    snippet: { type: 'string' },
    bodyExcerpt: { type: 'string', description: 'Truncated to bodyExcerptLength' },
    labels: { type: 'array', items: { type: 'string' } },
    isNewsletter: { type: 'boolean', description: 'True when message has List-Unsubscribe or List-Id headers' },
    containsMeetingReference: { type: 'boolean' },
    containsQuestion: { type: 'boolean' },
    actionRequested: { type: 'boolean' },
  },
} satisfies Record<string, unknown>;

// ─── Action Definitions ───────────────────────────────────────────────────────

const markdownBodyDescription =
  'Markdown body. Rendered as formatted HTML; the markdown source is sent as the plain-text fallback. Supports headings, lists, bold/italic, links, code blocks, blockquotes, and tables. Do not write raw HTML; tags like <p> are escaped. See the gmail skill for details.';

const sendEmailDef: ActionDefinition = {
  id: 'gmail.send_email',
  name: 'Send Email',
  description:
    'Sends a markdown-formatted email from the authenticated Gmail account. Supports cc/bcc and optional threading by passing replyToMessageId (which copies threadId and sets In-Reply-To/References so the reply lands in the same thread).',
  riskLevel: 'high',
  params: z.object({
    to: z
      .union([z.string(), z.array(z.string()).min(1)])
      .describe('Recipient email address, or an array of recipient email addresses.'),
    subject: z.string().describe('Email subject line.'),
    body: z.string().describe(markdownBodyDescription),
    cc: z.array(z.string()).optional().describe('Optional list of Cc recipients.'),
    bcc: z.array(z.string()).optional().describe('Optional list of Bcc recipients.'),
    replyToMessageId: z
      .string()
      .optional()
      .describe(
        'Optional Gmail message ID to reply to. When set, the new email is threaded with the original and uses In-Reply-To/References headers.',
      ),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Gmail message ID of the sent email' },
      threadId: { type: 'string' },
      labelIds: { type: 'array', items: { type: 'string' } },
      to: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      message: { type: 'string', description: 'Human-readable confirmation' },
    },
  },
};

const listMessagesDef: ActionDefinition = {
  id: 'gmail.list_messages',
  name: 'List Messages',
  description:
    'Lists Gmail messages for the authenticated user. Supports the full Gmail search syntax via the q parameter (e.g. "is:unread", "from:alice@example.com", "subject:invoice newer_than:7d"). Returns message IDs with sender, subject, date, and snippet for each result.',
  riskLevel: 'low',
  params: z.object({
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(10)
      .describe('Maximum number of messages to return (1-100). Defaults to 10.'),
    q: z
      .string()
      .optional()
      .describe(
        'Gmail search query using the same syntax as the Gmail search box. Examples: "is:unread", "from:boss@acme.com", "has:attachment newer_than:3d".',
      ),
    labelIds: z
      .array(z.string())
      .optional()
      .describe(
        'Only return messages with these label IDs (e.g. ["INBOX"], ["STARRED"]). Use list_labels to discover custom label IDs.',
      ),
    includeSpamTrash: z
      .boolean()
      .optional()
      .default(false)
      .describe('If true, also include messages from SPAM and TRASH.'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      messages: { type: 'array', items: gmailMessageListItemSchema },
      resultSizeEstimate: { type: 'number', description: 'Gmail-reported total — may exceed messages.length when there are more pages' },
      nextPageToken: { type: ['string', 'null'] },
    },
  },
};

const getMessageDef: ActionDefinition = {
  id: 'gmail.get_message',
  name: 'Get Message',
  description:
    'Fetches a single Gmail message by ID with headers, decoded plain-text body, HTML body, and a list of attachments (metadata only). Use list_messages to discover message IDs.',
  riskLevel: 'low',
  params: z.object({
    messageId: z.string().describe('The Gmail message ID, typically from list_messages results.'),
    format: z
      .enum(['full', 'metadata', 'minimal'])
      .optional()
      .default('full')
      .describe(
        '"full" returns headers + body + attachments; "metadata" returns headers only; "minimal" returns just labels/snippet.',
      ),
  }),
  outputSchema: {
    type: 'object',
    description: 'Shape depends on format: minimal omits headers/body/attachments; metadata adds headers; full adds body + attachments.',
    properties: {
      id: { type: 'string' },
      threadId: { type: 'string' },
      labelIds: { type: 'array', items: { type: 'string' } },
      snippet: { type: 'string' },
      historyId: { type: 'string' },
      internalDate: { type: 'string' },
      sizeEstimate: { type: 'number' },
      headers: gmailHeadersSchema,
      body: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          html: { type: 'string' },
        },
      },
      attachments: { type: 'array', items: gmailAttachmentSchema },
    },
  },
};

const modifyLabelsDef: ActionDefinition = {
  id: 'gmail.modify_labels',
  name: 'Modify Labels',
  description:
    'Adds and/or removes labels on a Gmail message. Use this to star (add STARRED), archive (remove INBOX), mark read (remove UNREAD), or apply custom labels. Discover label IDs with list_labels. At least one of addLabelIds or removeLabelIds must be provided.',
  riskLevel: 'medium',
  params: z
    .object({
      messageId: z.string().describe('The Gmail message ID to modify.'),
      addLabelIds: z
        .array(z.string())
        .optional()
        .describe(
          'Label IDs to add (e.g. ["STARRED"], ["IMPORTANT"], or a custom label ID from list_labels).',
        ),
      removeLabelIds: z
        .array(z.string())
        .optional()
        .describe(
          'Label IDs to remove (e.g. ["INBOX"] to archive, ["UNREAD"] to mark as read).',
        ),
    })
    .refine(
      (v) =>
        (v.addLabelIds && v.addLabelIds.length > 0) ||
        (v.removeLabelIds && v.removeLabelIds.length > 0),
      { message: 'Provide at least one of addLabelIds or removeLabelIds.' },
    ),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      threadId: { type: 'string' },
      labelIds: { type: 'array', items: { type: 'string' } },
      message: { type: 'string' },
    },
  },
};

const trashMessageDef: ActionDefinition = {
  id: 'gmail.trash_message',
  name: 'Trash Message',
  description:
    'Moves a Gmail message to Trash. This is the same as clicking Delete in the Gmail UI — reversible from the Trash folder for 30 days. Not a permanent delete.',
  riskLevel: 'high',
  params: z.object({
    messageId: z.string().describe('The Gmail message ID to move to Trash.'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      threadId: { type: 'string' },
      labelIds: { type: 'array', items: { type: 'string' } },
      message: { type: 'string' },
    },
  },
};

const createDraftDef: ActionDefinition = {
  id: 'gmail.create_draft',
  name: 'Create Draft',
  description:
    'Creates a markdown-formatted Gmail draft (does NOT send). Use this for AI-composed emails that the user should review before sending. The draft appears in the Gmail Drafts folder and can be sent later with send_draft, edited with update_draft, or deleted with delete_draft. Supports threading via replyToMessageId.',
  riskLevel: 'medium',
  params: z.object({
    to: z
      .union([z.string(), z.array(z.string()).min(1)])
      .describe('Recipient email address, or an array of recipient email addresses.'),
    subject: z.string().describe('Email subject line.'),
    body: z.string().describe(markdownBodyDescription),
    cc: z.array(z.string()).optional().describe('Optional list of Cc recipients.'),
    bcc: z.array(z.string()).optional().describe('Optional list of Bcc recipients.'),
    replyToMessageId: z
      .string()
      .optional()
      .describe(
        'Optional Gmail message ID to draft a reply to. The draft is threaded with the original.',
      ),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      draftId: { type: 'string' },
      messageId: { type: ['string', 'null'] },
      threadId: { type: ['string', 'null'] },
      to: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      message: { type: 'string' },
    },
  },
};

const listDraftsDef: ActionDefinition = {
  id: 'gmail.list_drafts',
  name: 'List Drafts',
  description:
    'Lists Gmail drafts for the authenticated user. Returns draft IDs along with the recipient, subject, snippet, and date for each. Use send_draft, update_draft, or delete_draft to act on a returned draft.',
  riskLevel: 'low',
  params: z.object({
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(25)
      .describe('Maximum number of drafts to return (1-100). Defaults to 25.'),
    q: z
      .string()
      .optional()
      .describe('Optional Gmail search query to filter drafts (e.g. "subject:proposal").'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      drafts: { type: 'array', items: gmailDraftListItemSchema },
      resultSizeEstimate: { type: 'number' },
      nextPageToken: { type: ['string', 'null'] },
    },
  },
};

const getDraftDef: ActionDefinition = {
  id: 'gmail.get_draft',
  name: 'Get Draft',
  description:
    'Fetches a single Gmail draft by ID with full headers and body. Use list_drafts to discover draft IDs.',
  riskLevel: 'low',
  params: z.object({
    draftId: z.string().describe('The Gmail draft ID, typically from list_drafts results.'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      draftId: { type: 'string' },
      messageId: { type: ['string', 'null'] },
      threadId: { type: ['string', 'null'] },
      labelIds: { type: 'array', items: { type: 'string' } },
      snippet: { type: 'string' },
      headers: gmailHeadersSchema,
      body: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          html: { type: 'string' },
        },
      },
    },
  },
};

const updateDraftDef: ActionDefinition = {
  id: 'gmail.update_draft',
  name: 'Update Draft',
  description:
    'Replaces the contents of an existing Gmail draft with markdown-formatted content. The new contents fully overwrite the old draft (this is a full replace, not a patch). Use this when iterating on an AI-composed draft before sending.',
  riskLevel: 'medium',
  params: z.object({
    draftId: z.string().describe('The Gmail draft ID to update.'),
    to: z
      .union([z.string(), z.array(z.string()).min(1)])
      .describe('Recipient email address, or an array of recipient email addresses.'),
    subject: z.string().describe('Email subject line.'),
    body: z.string().describe(markdownBodyDescription),
    cc: z.array(z.string()).optional().describe('Optional list of Cc recipients.'),
    bcc: z.array(z.string()).optional().describe('Optional list of Bcc recipients.'),
    replyToMessageId: z
      .string()
      .optional()
      .describe('Optional Gmail message ID to thread the draft with.'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      draftId: { type: 'string' },
      messageId: { type: ['string', 'null'] },
      threadId: { type: ['string', 'null'] },
      to: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      message: { type: 'string' },
    },
  },
};

const sendDraftDef: ActionDefinition = {
  id: 'gmail.send_draft',
  name: 'Send Draft',
  description:
    'Sends an existing Gmail draft. After sending, the draft is removed and the message appears in Sent. This is the second half of the compose-review-send flow that pairs with create_draft.',
  riskLevel: 'high',
  params: z.object({
    draftId: z
      .string()
      .describe('The Gmail draft ID to send (from create_draft or list_drafts).'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      draftId: { type: 'string' },
      messageId: { type: 'string', description: 'New message ID once sent' },
      threadId: { type: 'string' },
      labelIds: { type: 'array', items: { type: 'string' } },
      message: { type: 'string' },
    },
  },
};

const deleteDraftDef: ActionDefinition = {
  id: 'gmail.delete_draft',
  name: 'Delete Draft',
  description:
    'Permanently deletes a Gmail draft. This is irreversible — the draft is removed entirely, not moved to Trash. Use when an AI-composed draft was rejected or replaced.',
  riskLevel: 'high',
  params: z.object({
    draftId: z
      .string()
      .describe('The Gmail draft ID to delete (from create_draft or list_drafts).'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      draftId: { type: 'string' },
      message: { type: 'string' },
    },
  },
};

const listLabelsDef: ActionDefinition = {
  id: 'gmail.list_labels',
  name: 'List Labels',
  description:
    'Lists all Gmail labels for the authenticated user, including system labels (INBOX, SENT, STARRED, UNREAD, etc.) and custom user-created labels. Use the returned IDs with modify_labels or list_messages labelIds filter.',
  riskLevel: 'low',
  params: z.object({}),
  outputSchema: {
    type: 'object',
    properties: {
      labels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string', enum: ['system', 'user'] },
            messageListVisibility: { type: ['string', 'null'], enum: ['show', 'hide', null] },
            labelListVisibility: {
              type: ['string', 'null'],
              enum: ['labelShow', 'labelShowIfUnread', 'labelHide', null],
            },
          },
        },
      },
      count: { type: 'number' },
    },
  },
};

const triageInboxDef: ActionDefinition = {
  id: 'gmail.triage_inbox',
  name: 'Triage Inbox',
  description:
    "Composite action: fetches the user's most recent unread Gmail messages with full content and heuristic categorization in a single call. Returns headers, body excerpts, labels, plus per-message signals (newsletter, meeting reference, contains question, action requested) AND aggregate stats (total unread, top senders, breakdown by category). Designed for AI inbox triage workflows — use the returned data to decide which messages need a reply, can be archived, or warrant a draft response. Pairs naturally with create_draft, modify_labels, and trash_message.",
  riskLevel: 'medium',
  params: z.object({
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(20)
      .describe('How many unread messages to triage in one pass (1-50). Defaults to 20.'),
    additionalQuery: z
      .string()
      .optional()
      .describe(
        'Optional Gmail query appended to "is:unread", e.g. "newer_than:2d" or "-from:notifications@".',
      ),
    bodyExcerptLength: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .optional()
      .default(400)
      .describe('Max characters of body text to include per message (0 to skip bodies).'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'object',
        properties: {
          totalUnread: { type: 'number', description: 'Gmail-reported total — may exceed fetched' },
          fetched: { type: 'number' },
          failedFetches: { type: 'number', description: 'Per-message fetches that errored out' },
          topSenders: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                count: { type: 'number' },
              },
            },
          },
          newsletterCount: { type: 'number' },
          meetingReferenceCount: { type: 'number' },
          questionCount: { type: 'number' },
          actionRequestedCount: { type: 'number' },
        },
      },
      messages: { type: 'array', items: gmailTriageMessageSchema },
    },
  },
};

const allActions: ActionDefinition[] = [
  sendEmailDef,
  listMessagesDef,
  getMessageDef,
  modifyLabelsDef,
  trashMessageDef,
  createDraftDef,
  listDraftsDef,
  getDraftDef,
  updateDraftDef,
  sendDraftDef,
  deleteDraftDef,
  listLabelsDef,
  triageInboxDef,
];

// ─── Action Execution ─────────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = ctx.credentials.access_token || '';
  if (!token) return { success: false, error: 'Missing access token' };

  try {
    switch (actionId) {
      // ── Messages ────────────────────────────────────────────────────────────

      case 'gmail.send_email': {
        const p = sendEmailDef.params.parse(params);
        const { raw, threadId, toList } = await prepareMimeRequest(p, token);
        const res = await gmailFetch('/users/me/messages/send', token, {
          method: 'POST',
          body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
        });
        if (!res.ok) return gmailError(res);
        const data = (await res.json()) as GmailMessage;
        return {
          success: true,
          data: {
            id: data.id,
            threadId: data.threadId,
            labelIds: data.labelIds ?? [],
            to: toList,
            subject: p.subject,
            message: `Email sent to ${toList.join(', ')}.`,
          },
        };
      }

      case 'gmail.list_messages': {
        const p = listMessagesDef.params.parse(params);
        const qs = new URLSearchParams({ maxResults: String(p.maxResults ?? 10) });
        if (p.q) qs.set('q', p.q);
        if (p.includeSpamTrash) qs.set('includeSpamTrash', 'true');
        if (p.labelIds?.length) p.labelIds.forEach((id: string) => qs.append('labelIds', id));

        const listRes = await gmailFetch(`/users/me/messages?${qs}`, token);
        if (!listRes.ok) return gmailError(listRes);

        const listData = (await listRes.json()) as {
          messages?: Array<{ id: string }>;
          resultSizeEstimate?: number;
          nextPageToken?: string;
        };

        const messageRefs = listData.messages ?? [];
        if (messageRefs.length === 0) {
          return {
            success: true,
            data: { messages: [], resultSizeEstimate: listData.resultSizeEstimate ?? 0, nextPageToken: null },
          };
        }

        const detailed = await Promise.all(
          messageRefs.map((ref) =>
            gmailFetch(
              `/users/me/messages/${ref.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
              token,
            ).then((r) => (r.ok ? (r.json() as Promise<GmailMessage>) : null)),
          ),
        );

        const messages = detailed
          .filter((msg): msg is GmailMessage => msg !== null)
          .map((msg) => {
            const headers = msg.payload?.headers;
            return {
              id: msg.id,
              threadId: msg.threadId,
              labelIds: msg.labelIds ?? [],
              snippet: msg.snippet ?? '',
              from: findHeaderValue(headers, 'From'),
              to: findHeaderValue(headers, 'To'),
              subject: findHeaderValue(headers, 'Subject'),
              date: findHeaderValue(headers, 'Date'),
            };
          });

        return {
          success: true,
          data: {
            messages,
            resultSizeEstimate: listData.resultSizeEstimate ?? messages.length,
            nextPageToken: listData.nextPageToken ?? null,
          },
        };
      }

      case 'gmail.get_message': {
        const p = getMessageDef.params.parse(params);
        const format = p.format ?? 'full';
        const res = await gmailFetch(`/users/me/messages/${p.messageId}?format=${format}`, token);
        if (!res.ok) return gmailError(res);
        const msg = (await res.json()) as GmailMessage;
        const headers = msg.payload?.headers;

        const base = {
          id: msg.id,
          threadId: msg.threadId,
          labelIds: msg.labelIds ?? [],
          snippet: msg.snippet ?? '',
          historyId: msg.historyId,
          internalDate: msg.internalDate,
          sizeEstimate: msg.sizeEstimate,
        };

        if (format === 'minimal') {
          return { success: true, data: base };
        }

        const headerSummary = {
          from: findHeaderValue(headers, 'From'),
          to: findHeaderValue(headers, 'To'),
          cc: findHeaderValue(headers, 'Cc'),
          bcc: findHeaderValue(headers, 'Bcc'),
          subject: findHeaderValue(headers, 'Subject'),
          date: findHeaderValue(headers, 'Date'),
          messageIdHeader: findHeaderValue(headers, 'Message-Id'),
        };

        if (format === 'metadata') {
          return { success: true, data: { ...base, headers: headerSummary } };
        }

        // full
        const { text, html } = extractMessageBody(msg.payload);
        const attachments = collectAttachments(msg.payload);
        return {
          success: true,
          data: { ...base, headers: headerSummary, body: { text, html }, attachments },
        };
      }

      case 'gmail.modify_labels': {
        const p = modifyLabelsDef.params.parse(params);
        const res = await gmailFetch(`/users/me/messages/${p.messageId}/modify`, token, {
          method: 'POST',
          body: JSON.stringify({ addLabelIds: p.addLabelIds, removeLabelIds: p.removeLabelIds }),
        });
        if (!res.ok) return gmailError(res);
        const data = (await res.json()) as GmailMessage;
        return {
          success: true,
          data: {
            id: data.id,
            threadId: data.threadId,
            labelIds: data.labelIds ?? [],
            message: `Labels updated on message ${p.messageId}.`,
          },
        };
      }

      case 'gmail.trash_message': {
        const { messageId } = trashMessageDef.params.parse(params);
        const res = await gmailFetch(`/users/me/messages/${messageId}/trash`, token, {
          method: 'POST',
        });
        if (!res.ok) return gmailError(res);
        const data = (await res.json()) as GmailMessage;
        return {
          success: true,
          data: {
            id: data.id,
            threadId: data.threadId,
            labelIds: data.labelIds ?? [],
            message: `Message ${messageId} moved to Trash. Recoverable from the Trash folder in the Gmail UI.`,
          },
        };
      }

      // ── Drafts ───────────────────────────────────────────────────────────────

      case 'gmail.create_draft': {
        const p = createDraftDef.params.parse(params);
        const { raw, threadId, toList } = await prepareMimeRequest(p, token);
        const res = await gmailFetch('/users/me/drafts', token, {
          method: 'POST',
          body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
        });
        if (!res.ok) return gmailError(res);
        const data = (await res.json()) as GmailDraft;
        return {
          success: true,
          data: {
            draftId: data.id,
            messageId: data.message?.id,
            threadId: data.message?.threadId,
            to: toList,
            subject: p.subject,
            message: `Draft created. Use send_draft with draftId="${data.id}" to send it, or update_draft to edit it first.`,
          },
        };
      }

      case 'gmail.list_drafts': {
        const p = listDraftsDef.params.parse(params);
        const qs = new URLSearchParams({ maxResults: String(p.maxResults ?? 25) });
        if (p.q) qs.set('q', p.q);

        const listRes = await gmailFetch(`/users/me/drafts?${qs}`, token);
        if (!listRes.ok) return gmailError(listRes);

        const listData = (await listRes.json()) as {
          drafts?: Array<{ id: string }>;
          resultSizeEstimate?: number;
          nextPageToken?: string;
        };

        const draftRefs = listData.drafts ?? [];
        if (draftRefs.length === 0) {
          return {
            success: true,
            data: { drafts: [], resultSizeEstimate: listData.resultSizeEstimate ?? 0, nextPageToken: null },
          };
        }

        const detailed = await Promise.all(
          draftRefs.map((ref) =>
            gmailFetch(`/users/me/drafts/${ref.id}?format=metadata`, token).then((r) =>
              r.ok ? (r.json() as Promise<GmailDraft>) : null,
            ),
          ),
        );

        const drafts = detailed
          .filter((d): d is GmailDraft => d !== null)
          .map((draft) => {
            const msg = draft.message;
            const headers = msg?.payload?.headers;
            return {
              draftId: draft.id,
              messageId: msg?.id,
              threadId: msg?.threadId,
              snippet: msg?.snippet ?? '',
              to: findHeaderValue(headers, 'To'),
              cc: findHeaderValue(headers, 'Cc'),
              subject: findHeaderValue(headers, 'Subject'),
              date: findHeaderValue(headers, 'Date'),
            };
          });

        return {
          success: true,
          data: {
            drafts,
            resultSizeEstimate: listData.resultSizeEstimate ?? drafts.length,
            nextPageToken: listData.nextPageToken ?? null,
          },
        };
      }

      case 'gmail.get_draft': {
        const { draftId } = getDraftDef.params.parse(params);
        const res = await gmailFetch(`/users/me/drafts/${draftId}?format=full`, token);
        if (!res.ok) return gmailError(res);
        const draft = (await res.json()) as GmailDraft;
        const msg = draft.message;
        const headers = msg?.payload?.headers;
        const { text, html } = extractMessageBody(msg?.payload);
        return {
          success: true,
          data: {
            draftId: draft.id,
            messageId: msg?.id,
            threadId: msg?.threadId,
            labelIds: msg?.labelIds ?? [],
            snippet: msg?.snippet ?? '',
            headers: {
              from: findHeaderValue(headers, 'From'),
              to: findHeaderValue(headers, 'To'),
              cc: findHeaderValue(headers, 'Cc'),
              bcc: findHeaderValue(headers, 'Bcc'),
              subject: findHeaderValue(headers, 'Subject'),
              date: findHeaderValue(headers, 'Date'),
            },
            body: { text, html },
          },
        };
      }

      case 'gmail.update_draft': {
        const p = updateDraftDef.params.parse(params);
        const { raw, threadId, toList } = await prepareMimeRequest(p, token);
        const res = await gmailFetch(`/users/me/drafts/${p.draftId}`, token, {
          method: 'PUT',
          body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
        });
        if (!res.ok) return gmailError(res);
        const data = (await res.json()) as GmailDraft;
        return {
          success: true,
          data: {
            draftId: data.id,
            messageId: data.message?.id,
            threadId: data.message?.threadId,
            to: toList,
            subject: p.subject,
            message: `Draft ${p.draftId} updated.`,
          },
        };
      }

      case 'gmail.send_draft': {
        const { draftId } = sendDraftDef.params.parse(params);
        const res = await gmailFetch('/users/me/drafts/send', token, {
          method: 'POST',
          body: JSON.stringify({ id: draftId }),
        });
        if (!res.ok) return gmailError(res);
        const data = (await res.json()) as GmailMessage;
        return {
          success: true,
          data: {
            draftId,
            messageId: data.id,
            threadId: data.threadId,
            labelIds: data.labelIds ?? [],
            message: `Draft ${draftId} sent. Message ID: ${data.id}.`,
          },
        };
      }

      case 'gmail.delete_draft': {
        const { draftId } = deleteDraftDef.params.parse(params);
        const res = await gmailFetch(`/users/me/drafts/${draftId}`, token, { method: 'DELETE' });
        if (!res.ok) return gmailError(res);
        return {
          success: true,
          data: { draftId, message: `Draft ${draftId} permanently deleted.` },
        };
      }

      // ── Labels + Triage ──────────────────────────────────────────────────────

      case 'gmail.list_labels': {
        listLabelsDef.params.parse(params);
        const res = await gmailFetch('/users/me/labels', token);
        if (!res.ok) return gmailError(res);
        const data = (await res.json()) as { labels?: GmailLabel[] };
        const labels = (data.labels ?? []).map((label) => ({
          id: label.id,
          name: label.name,
          type: label.type,
          messageListVisibility: label.messageListVisibility,
          labelListVisibility: label.labelListVisibility,
        }));
        return { success: true, data: { labels, count: labels.length } };
      }

      case 'gmail.triage_inbox': {
        const p = triageInboxDef.params.parse(params);
        const queryParts = ['is:unread', p.additionalQuery].filter(Boolean);
        const query = queryParts.join(' ');
        const qs = new URLSearchParams({ maxResults: String(p.maxResults ?? 20), q: query });

        const listRes = await gmailFetch(`/users/me/messages?${qs}`, token);
        if (!listRes.ok) return gmailError(listRes);

        const listData = (await listRes.json()) as {
          messages?: Array<{ id: string }>;
          resultSizeEstimate?: number;
        };

        const totalUnread = listData.resultSizeEstimate ?? 0;
        const messageRefs = listData.messages ?? [];

        if (messageRefs.length === 0) {
          return {
            success: true,
            data: {
              summary: {
                totalUnread,
                fetched: 0,
                topSenders: [],
                newsletterCount: 0,
                meetingReferenceCount: 0,
                questionCount: 0,
                actionRequestedCount: 0,
              },
              messages: [],
            },
          };
        }

        // Use allSettled so a single failed fetch doesn't kill the whole triage
        const settled = await Promise.allSettled(
          messageRefs.map((ref) =>
            gmailFetch(`/users/me/messages/${ref.id}?format=full`, token).then((r) =>
              r.ok ? (r.json() as Promise<GmailMessage>) : Promise.reject(new Error(`${r.status}`)),
            ),
          ),
        );

        const failedFetches = settled.filter((r) => r.status === 'rejected').length;
        const detailed: GmailMessage[] = settled
          .filter((r): r is PromiseFulfilledResult<GmailMessage> => r.status === 'fulfilled')
          .map((r) => r.value);

        const MEETING_PATTERN =
          /\b(meeting|call|invite|invitation|calendar|schedule|reschedul|zoom|google meet|teams)\b/i;
        const QUESTION_PATTERN = /\?/;
        const ACTION_PATTERN =
          /\b(please|could you|can you|let me know|need|review|approve|sign|deadline|by (mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next week|eod|cob))\b/i;
        const excerptLength = p.bodyExcerptLength ?? 400;

        const messages = detailed.map((msg) => {
          const headers = msg.payload?.headers;
          const from = findHeaderValue(headers, 'From');
          const subject = findHeaderValue(headers, 'Subject') ?? '(no subject)';
          const hasUnsubscribe =
            findHeaderValue(headers, 'List-Unsubscribe') !== null ||
            findHeaderValue(headers, 'List-Id') !== null;

          let bodyText = '';
          if (excerptLength > 0) {
            const { text, html } = extractMessageBody(msg.payload);
            bodyText = text || html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, ' ');
          }
          const bodyExcerpt = excerptLength > 0 ? truncate(bodyText, excerptLength) : '';
          const searchSurface = `${subject} ${bodyText}`;

          return {
            id: msg.id,
            threadId: msg.threadId,
            from,
            domain: extractDomain(from),
            to: findHeaderValue(headers, 'To'),
            subject,
            date: findHeaderValue(headers, 'Date'),
            snippet: msg.snippet ?? '',
            bodyExcerpt,
            labels: msg.labelIds ?? [],
            isNewsletter: hasUnsubscribe,
            containsMeetingReference: MEETING_PATTERN.test(searchSurface),
            containsQuestion: QUESTION_PATTERN.test(searchSurface),
            actionRequested: ACTION_PATTERN.test(searchSurface),
          };
        });

        const senderCounts = new Map<string, number>();
        for (const m of messages) {
          if (!m.from) continue;
          senderCounts.set(m.from, (senderCounts.get(m.from) ?? 0) + 1);
        }
        const topSenders = [...senderCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([from, count]) => ({ from, count }));

        return {
          success: true,
          data: {
            summary: {
              totalUnread,
              fetched: messages.length,
              failedFetches,
              topSenders,
              newsletterCount: messages.filter((m) => m.isNewsletter).length,
              meetingReferenceCount: messages.filter((m) => m.containsMeetingReference).length,
              questionCount: messages.filter((m) => m.containsQuestion).length,
              actionRequestedCount: messages.filter((m) => m.actionRequested).length,
            },
            messages,
          },
        };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const gmailActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
