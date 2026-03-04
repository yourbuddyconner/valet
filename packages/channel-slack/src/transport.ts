import type {
  ChannelTransport,
  ChannelTarget,
  ChannelContext,
  InboundMessage,
  OutboundMessage,
  RoutingMetadata,
  SendResult,
} from '@valet/sdk';
import { markdownToSlackMrkdwn } from './format.js';

// ─── Slack API Helpers ──────────────────────────────────────────────────────

const SLACK_API = 'https://slack.com/api';

function slackUrl(method: string): string {
  return `${SLACK_API}/${method}`;
}

async function slackApiCall(
  method: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ ok: boolean; ts?: string; error?: string; [key: string]: unknown }> {
  const resp = await fetch(slackUrl(method), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, error: `Slack API HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }

  return (await resp.json()) as { ok: boolean; ts?: string; error?: string };
}

// ─── Event subtypes to skip ─────────────────────────────────────────────────

const SKIP_SUBTYPES = new Set([
  'message_changed',
  'message_deleted',
  'bot_message',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'group_topic',
  'group_purpose',
  'group_name',
  'group_archive',
  'group_unarchive',
  'file_comment',
  'file_mention',
  'pinned_item',
  'unpinned_item',
]);

// ─── Text Cleanup ───────────────────────────────────────────────────────────

/**
 * Clean Slack-specific markup from message text:
 * - Replace <@USER_ID> with @DisplayName using mentionMap, or @USER_ID as fallback
 * - Decode Slack channel links: <#C123|general> → #general
 * - Decode URL links: <https://example.com|label> → label
 *
 * @param mentionMap - Map of Slack user ID → display name (e.g. { "U123": "Agent-Ops" })
 */
function cleanSlackText(text: string, mentionMap?: Record<string, string>): string {
  let cleaned = text;

  // Replace user mentions: <@U123> → @DisplayName or @U123
  cleaned = cleaned.replace(/<@([A-Z0-9]+)>/g, (_match, userId: string) => {
    const name = mentionMap?.[userId];
    return name ? `@${name}` : `@${userId}`;
  });

  // Replace channel links: <#C123|general> → #general
  cleaned = cleaned.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');

  // Replace URL links: <url|label> → label, <url> → url
  cleaned = cleaned.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2');
  cleaned = cleaned.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  return cleaned.trim();
}

// ─── SlackTransport ─────────────────────────────────────────────────────────

export class SlackTransport implements ChannelTransport {
  readonly channelType = 'slack';

  verifySignature(): boolean {
    // Slack signature verification is async (Web Crypto API),
    // so it's handled directly in the Slack events route via verifySlackSignature().
    // This method exists to satisfy the ChannelTransport interface.
    return true;
  }

  async parseInbound(
    _rawHeaders: Record<string, string>,
    rawBody: string,
    routing: RoutingMetadata,
  ): Promise<InboundMessage | null> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = payload.type as string | undefined;

    // url_verification is handled by the route, not the transport
    if (type === 'url_verification') return null;

    // Only handle event_callback
    if (type !== 'event_callback') return null;

    const teamId = payload.team_id as string | undefined;
    const event = payload.event as Record<string, unknown> | undefined;
    if (!event) return null;

    const eventType = event.type as string | undefined;

    // Handle message events and app_mention events
    if (eventType !== 'message' && eventType !== 'app_mention') return null;

    // Skip subtypes we don't care about
    const subtype = event.subtype as string | undefined;
    if (subtype && SKIP_SUBTYPES.has(subtype)) return null;

    // Allow null subtype (regular message) and file_share
    if (subtype && subtype !== 'file_share') return null;

    const channel = event.channel as string | undefined;
    const user = event.user as string | undefined;
    const rawText = (event.text as string) || '';
    const mentionMap = routing.mentionMap as Record<string, string> | undefined;
    const text = cleanSlackText(rawText, mentionMap);
    const ts = event.ts as string | undefined;
    const threadTs = event.thread_ts as string | undefined;
    const eventTs = event.event_ts as string | undefined;

    if (!channel || !user) return null;

    // Skip bot messages (bot_id present means it's from a bot)
    if (event.bot_id) return null;

    // Extract file attachments
    const files = event.files as Array<Record<string, unknown>> | undefined;
    const attachments: InboundMessage['attachments'] = [];

    if (files && files.length > 0) {
      for (const file of files) {
        const urlPrivate = file.url_private as string | undefined;
        const mimetype = file.mimetype as string | undefined;
        const name = file.name as string | undefined;
        const size = file.size as number | undefined;
        const filetype = file.filetype as string | undefined;

        if (!urlPrivate) continue;

        const isImage = mimetype?.startsWith('image/') ||
          ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(filetype || '');

        attachments.push({
          type: isImage ? 'image' : 'file',
          url: urlPrivate,
          mimeType: mimetype || 'application/octet-stream',
          fileName: name,
          size,
        });
      }
    }

    // Check for slash command pattern
    const commandMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (commandMatch) {
      return {
        channelType: 'slack',
        channelId: channel,
        senderId: user,
        senderName: user,
        text: commandMatch[2]?.trim() || '',
        attachments,
        command: commandMatch[1],
        commandArgs: commandMatch[2]?.trim(),
        messageId: ts,
        metadata: { teamId, threadTs, eventTs, slackEventType: eventType, slackChannelType: event.channel_type },
      };
    }

    return {
      channelType: 'slack',
      channelId: channel,
      senderId: user,
      senderName: (routing.senderName as string) || user,
      text: text || (attachments.length > 0 ? '[Attachment]' : ''),
      attachments,
      messageId: ts,
      metadata: { teamId, threadTs, eventTs, slackEventType: eventType, slackChannelType: event.channel_type },
    };
  }

  scopeKeyParts(
    message: InboundMessage,
    _userId: string,
  ): { channelType: string; channelId: string } {
    const teamId = (message.metadata?.teamId as string) || '';
    const threadTs = message.metadata?.threadTs as string | undefined;
    const channelId = threadTs
      ? `${teamId}:${message.channelId}:${threadTs}`
      : `${teamId}:${message.channelId}`;
    return { channelType: 'slack', channelId };
  }

  formatMarkdown(markdown: string): string {
    return markdownToSlackMrkdwn(markdown);
  }

  async sendMessage(
    target: ChannelTarget,
    message: OutboundMessage,
    ctx: ChannelContext,
  ): Promise<SendResult> {
    const text = message.markdown || message.text || '';
    const formatted = this.formatMarkdown(text);

    const body: Record<string, unknown> = {
      channel: target.channelId,
      text: formatted,
      unfurl_links: false,
    };

    if (target.threadId) {
      body.thread_ts = target.threadId;
    }

    const result = await slackApiCall('chat.postMessage', body, ctx.token);

    if (!result.ok) {
      return { success: false, error: `Slack chat.postMessage error: ${result.error}` };
    }

    return { success: true, messageId: result.ts };
  }

  async editMessage(
    target: ChannelTarget,
    messageId: string,
    message: OutboundMessage,
    ctx: ChannelContext,
  ): Promise<SendResult> {
    const text = message.markdown || message.text || '';
    const formatted = this.formatMarkdown(text);

    const result = await slackApiCall('chat.update', {
      channel: target.channelId,
      ts: messageId,
      text: formatted,
    }, ctx.token);

    if (!result.ok) {
      return { success: false, error: `Slack chat.update error: ${result.error}` };
    }

    return { success: true, messageId: result.ts };
  }

  async deleteMessage(
    target: ChannelTarget,
    messageId: string,
    ctx: ChannelContext,
  ): Promise<boolean> {
    const result = await slackApiCall('chat.delete', {
      channel: target.channelId,
      ts: messageId,
    }, ctx.token);

    return result.ok;
  }

  // Slack has no bot typing indicator API
  // sendTypingIndicator is intentionally omitted

  // Slack Events API URL is configured in app settings, not per-user
  // registerWebhook / unregisterWebhook are intentionally omitted
}
