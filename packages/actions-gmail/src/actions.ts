import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { gmailFetch, decodeBase64Url, encodeBase64Url } from './api.js';

/** Build a descriptive error from a failed Gmail API response. */
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

// ─── Internal Types ──────────────────────────────────────────────────────────

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  payload?: GmailMessagePayload;
}

interface GmailMessagePayload {
  mimeType: string;
  filename?: string;
  headers: Array<{ name: string; value: string }>;
  body: { attachmentId?: string; size: number; data?: string };
  parts?: GmailMessagePayload[];
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  /** RFC 2822 Message-ID header value. */
  rfc822MessageId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  snippet: string;
  labels: string[];
  date: Date;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
  isUnread: boolean;
  isStarred: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseMessage(message: GmailMessage): ParsedEmail {
  const headers = message.payload?.headers || [];
  const getHeader = (name: string): string => {
    const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return header?.value || '';
  };

  const parseAddresses = (value: string): string[] => {
    if (!value) return [];
    return value.split(',').map((a) => a.trim()).filter(Boolean);
  };

  let body = '';
  let bodyHtml = '';
  const attachments: ParsedEmail['attachments'] = [];

  const extractParts = (payload: GmailMessagePayload | undefined) => {
    if (!payload) return;
    if (payload.mimeType === 'text/plain' && payload.body.data) {
      body = decodeBase64Url(payload.body.data);
    } else if (payload.mimeType === 'text/html' && payload.body.data) {
      bodyHtml = decodeBase64Url(payload.body.data);
    } else if (payload.filename && payload.body.attachmentId) {
      attachments.push({
        id: payload.body.attachmentId,
        filename: payload.filename,
        mimeType: payload.mimeType,
        size: payload.body.size,
      });
    }
    if (payload.parts) payload.parts.forEach(extractParts);
  };

  extractParts(message.payload);
  if (!body && !bodyHtml) body = message.snippet;

  return {
    id: message.id,
    threadId: message.threadId,
    rfc822MessageId: getHeader('message-id'),
    from: getHeader('from'),
    to: parseAddresses(getHeader('to')),
    cc: parseAddresses(getHeader('cc')),
    bcc: parseAddresses(getHeader('bcc')),
    subject: getHeader('subject'),
    body,
    bodyHtml: bodyHtml || undefined,
    snippet: message.snippet,
    labels: message.labelIds || [],
    date: new Date(parseInt(message.internalDate)),
    attachments,
    isUnread: message.labelIds?.includes('UNREAD') || false,
    isStarred: message.labelIds?.includes('STARRED') || false,
  };
}

function buildRawEmail(options: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines: string[] = [
    `To: ${options.to.join(', ')}`,
    `Subject: ${options.subject}`,
    'MIME-Version: 1.0',
  ];
  if (options.cc?.length) lines.push(`Cc: ${options.cc.join(', ')}`);
  if (options.bcc?.length) lines.push(`Bcc: ${options.bcc.join(', ')}`);
  if (options.replyTo) lines.push(`Reply-To: ${options.replyTo}`);
  if (options.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) lines.push(`References: ${options.references}`);

  // Normalize bare \n to \r\n per RFC 2822
  const normalizeLineEndings = (s: string) => s.replace(/\r?\n/g, '\r\n');

  if (options.bodyHtml) {
    lines.push('Content-Type: multipart/alternative; boundary="alt_boundary"');
    lines.push('');
    lines.push('--alt_boundary');
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('');
    lines.push(normalizeLineEndings(options.body));
    lines.push('');
    lines.push('--alt_boundary');
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('');
    lines.push(normalizeLineEndings(options.bodyHtml));
    lines.push('');
    lines.push('--alt_boundary--');
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('');
    lines.push(normalizeLineEndings(options.body));
  }

  return encodeBase64Url(lines.join('\r\n'));
}

// ─── Action Definitions ──────────────────────────────────────────────────────

const getMessage: ActionDefinition = {
  id: 'gmail.get_message',
  name: 'Get Message',
  description: 'Get a single email by ID',
  riskLevel: 'low',
  params: z.object({ messageId: z.string() }),
};

const listMessages: ActionDefinition = {
  id: 'gmail.list_messages',
  name: 'List Messages',
  description: 'List emails with optional query filter',
  riskLevel: 'low',
  params: z.object({
    query: z.string().optional().describe('Gmail search query'),
    labelIds: z.array(z.string()).optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
  }),
};

const sendEmail: ActionDefinition = {
  id: 'gmail.send_email',
  name: 'Send Email',
  description: 'Send a new email',
  riskLevel: 'high',
  params: z.object({
    to: z.array(z.string()),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    subject: z.string(),
    body: z.string(),
    bodyHtml: z.string().optional(),
    replyTo: z.string().optional(),
    threadId: z.string().optional(),
  }),
};

const replyToEmail: ActionDefinition = {
  id: 'gmail.reply_to_email',
  name: 'Reply to Email',
  description: 'Reply to an existing email',
  riskLevel: 'high',
  params: z.object({
    originalMessageId: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    subject: z.string(),
    body: z.string(),
    bodyHtml: z.string().optional(),
  }),
};

const createDraft: ActionDefinition = {
  id: 'gmail.create_draft',
  name: 'Create Draft',
  description: 'Create a draft email',
  riskLevel: 'medium',
  params: z.object({
    to: z.array(z.string()),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    subject: z.string(),
    body: z.string(),
    bodyHtml: z.string().optional(),
    threadId: z.string().optional(),
  }),
};

const sendDraft: ActionDefinition = {
  id: 'gmail.send_draft',
  name: 'Send Draft',
  description: 'Send an existing draft',
  riskLevel: 'high',
  params: z.object({ draftId: z.string() }),
};

const modifyLabels: ActionDefinition = {
  id: 'gmail.modify_labels',
  name: 'Modify Labels',
  description: 'Add or remove labels from a message',
  riskLevel: 'medium',
  params: z.object({
    messageId: z.string(),
    addLabelIds: z.array(z.string()).optional(),
    removeLabelIds: z.array(z.string()).optional(),
  }),
};

const archiveMessage: ActionDefinition = {
  id: 'gmail.archive',
  name: 'Archive',
  description: 'Archive a message (remove from inbox)',
  riskLevel: 'medium',
  params: z.object({ messageId: z.string() }),
};

const starMessage: ActionDefinition = {
  id: 'gmail.star',
  name: 'Star',
  description: 'Star a message',
  riskLevel: 'low',
  params: z.object({ messageId: z.string() }),
};

const trashMessage: ActionDefinition = {
  id: 'gmail.trash',
  name: 'Trash',
  description: 'Move a message to trash',
  riskLevel: 'high',
  params: z.object({ messageId: z.string() }),
};

const markRead: ActionDefinition = {
  id: 'gmail.mark_read',
  name: 'Mark as Read',
  description: 'Mark a message as read',
  riskLevel: 'low',
  params: z.object({ messageId: z.string() }),
};

const getLabels: ActionDefinition = {
  id: 'gmail.get_labels',
  name: 'Get Labels',
  description: 'List all labels',
  riskLevel: 'low',
  params: z.object({}),
};

const getAttachment: ActionDefinition = {
  id: 'gmail.get_attachment',
  name: 'Get Attachment',
  description: 'Get attachment data from a message',
  riskLevel: 'low',
  params: z.object({
    messageId: z.string(),
    attachmentId: z.string(),
  }),
};

const allActions: ActionDefinition[] = [
  getMessage,
  listMessages,
  sendEmail,
  replyToEmail,
  createDraft,
  sendDraft,
  modifyLabels,
  archiveMessage,
  starMessage,
  trashMessage,
  markRead,
  getLabels,
  getAttachment,
];

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = ctx.credentials.access_token || '';
  if (!token) return { success: false, error: 'Missing access token' };

  try {
    switch (actionId) {
      case 'gmail.get_message': {
        const { messageId } = getMessage.params.parse(params);
        const res = await gmailFetch(`/users/me/messages/${messageId}?format=full`, token);
        if (!res.ok) return gmailError(res);
        const msg = (await res.json()) as GmailMessage;
        return { success: true, data: parseMessage(msg) };
      }

      case 'gmail.list_messages': {
        const p = listMessages.params.parse(params);
        const qs = new URLSearchParams({ maxResults: String(p.maxResults || 20) });
        if (p.query) qs.set('q', p.query);
        if (p.pageToken) qs.set('pageToken', p.pageToken);
        if (p.labelIds?.length) p.labelIds.forEach((id: string) => qs.append('labelIds', id));

        const listRes = await gmailFetch(`/users/me/messages?${qs}`, token);
        if (!listRes.ok) return gmailError(listRes);

        const listData = (await listRes.json()) as {
          messages?: Array<{ id: string }>;
          nextPageToken?: string;
        };

        const messages: ParsedEmail[] = [];
        for (const msg of listData.messages || []) {
          const fullRes = await gmailFetch(`/users/me/messages/${msg.id}?format=full`, token);
          if (fullRes.ok) {
            messages.push(parseMessage((await fullRes.json()) as GmailMessage));
          }
        }
        return { success: true, data: { messages, nextPageToken: listData.nextPageToken } };
      }

      case 'gmail.send_email': {
        const p = sendEmail.params.parse(params);
        const raw = buildRawEmail(p);
        const body: Record<string, unknown> = { raw };
        if (p.threadId) body.threadId = p.threadId;

        const res = await gmailFetch('/users/me/messages/send', token, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) return gmailError(res);
        return { success: true, data: await res.json() };
      }

      case 'gmail.reply_to_email': {
        const p = replyToEmail.params.parse(params);
        // Get original to find threadId and Message-ID for threading headers
        const origRes = await gmailFetch(`/users/me/messages/${p.originalMessageId}?format=full`, token);
        if (!origRes.ok) return gmailError(origRes);
        const original = parseMessage((await origRes.json()) as GmailMessage);

        const subject = p.subject.startsWith('Re:') ? p.subject : `Re: ${original.subject}`;
        const raw = buildRawEmail({
          ...p,
          subject,
          inReplyTo: original.rfc822MessageId || undefined,
          references: original.rfc822MessageId || undefined,
        });
        const res = await gmailFetch('/users/me/messages/send', token, {
          method: 'POST',
          body: JSON.stringify({ raw, threadId: original.threadId }),
        });
        if (!res.ok) return gmailError(res);
        return { success: true, data: await res.json() };
      }

      case 'gmail.create_draft': {
        const p = createDraft.params.parse(params);
        const raw = buildRawEmail(p);
        const res = await gmailFetch('/users/me/drafts', token, {
          method: 'POST',
          body: JSON.stringify({ message: { raw, threadId: p.threadId } }),
        });
        if (!res.ok) return gmailError(res);
        return { success: true, data: await res.json() };
      }

      case 'gmail.send_draft': {
        const { draftId } = sendDraft.params.parse(params);
        const res = await gmailFetch('/users/me/drafts/send', token, {
          method: 'POST',
          body: JSON.stringify({ id: draftId }),
        });
        if (!res.ok) return gmailError(res);
        return { success: true, data: await res.json() };
      }

      case 'gmail.modify_labels': {
        const { messageId, addLabelIds, removeLabelIds } = modifyLabels.params.parse(params);
        const res = await gmailFetch(`/users/me/messages/${messageId}/modify`, token, {
          method: 'POST',
          body: JSON.stringify({ addLabelIds, removeLabelIds }),
        });
        if (!res.ok) return gmailError(res);
        return { success: true };
      }

      case 'gmail.archive': {
        const { messageId } = archiveMessage.params.parse(params);
        const res = await gmailFetch(`/users/me/messages/${messageId}/modify`, token, {
          method: 'POST',
          body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
        });
        if (!res.ok) return gmailError(res);
        return { success: true };
      }

      case 'gmail.star': {
        const { messageId } = starMessage.params.parse(params);
        const res = await gmailFetch(`/users/me/messages/${messageId}/modify`, token, {
          method: 'POST',
          body: JSON.stringify({ addLabelIds: ['STARRED'] }),
        });
        if (!res.ok) return gmailError(res);
        return { success: true };
      }

      case 'gmail.trash': {
        const { messageId } = trashMessage.params.parse(params);
        const res = await gmailFetch(`/users/me/messages/${messageId}/trash`, token, {
          method: 'POST',
        });
        if (!res.ok) return gmailError(res);
        return { success: true };
      }

      case 'gmail.mark_read': {
        const { messageId } = markRead.params.parse(params);
        const res = await gmailFetch(`/users/me/messages/${messageId}/modify`, token, {
          method: 'POST',
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
        });
        if (!res.ok) return gmailError(res);
        return { success: true };
      }

      case 'gmail.get_labels': {
        getLabels.params.parse(params);
        const res = await gmailFetch('/users/me/labels', token);
        if (!res.ok) return gmailError(res);
        return { success: true, data: await res.json() };
      }

      case 'gmail.get_attachment': {
        const { messageId, attachmentId } = getAttachment.params.parse(params);
        const res = await gmailFetch(
          `/users/me/messages/${messageId}/attachments/${attachmentId}`,
          token,
        );
        if (!res.ok) return gmailError(res);
        return { success: true, data: await res.json() };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const gmailActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
