import type {
  ChannelTransport,
  ChannelTarget,
  ChannelContext,
  InboundMessage,
  OutboundMessage,
  RoutingMetadata,
  SendResult,
  InteractivePrompt,
  InteractivePromptRef,
  InteractiveResolution,
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

/** GET-based Slack API call for read methods (conversations.info, etc.) */
async function slackApiGet(
  method: string,
  params: Record<string, string>,
  token: string,
): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> {
  const url = new URL(slackUrl(method));
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, error: `Slack API HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }

  return (await resp.json()) as { ok: boolean; error?: string; [key: string]: unknown };
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

    // Handle assistant thread events (Agents & AI Apps surface)
    if (eventType === 'assistant_thread_started' || eventType === 'assistant_thread_context_changed') {
      const assistantThread = event.assistant_thread as Record<string, unknown> | undefined;
      const channel = (event.channel as string) || (assistantThread?.channel_id as string);
      const threadTs = (assistantThread?.thread_ts as string) || (event.thread_ts as string);
      const senderUserId = (assistantThread?.user_id as string) || '';
      if (!channel || !threadTs) return null;

      return {
        channelType: 'slack',
        channelId: channel,
        senderId: senderUserId,
        senderName: '',
        text: '',
        attachments: [],
        metadata: {
          teamId,
          threadTs,
          slackEventType: eventType,
          slackChannelType: event.channel_type,
        },
      };
    }

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

    // Persona identity overrides (requires chat:write.customize scope)
    if (message.platformOptions?.username) {
      body.username = message.platformOptions.username;
    }
    if (message.platformOptions?.icon_url) {
      body.icon_url = message.platformOptions.icon_url;
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

  // ─── Agent Surface (Agents & AI Apps) ─────────────────────────────────

  /**
   * Set the assistant thread status (shimmer "thinking" indicator).
   * Shows as "<App Name> is thinking..." with a sweeping gradient animation.
   * Auto-clears when a message is posted or after 2 minutes.
   */
  async setThreadStatus(
    target: ChannelTarget,
    status: string,
    ctx: ChannelContext,
    loadingMessages?: string[],
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      channel_id: target.channelId,
      thread_ts: target.threadId,
      status,
    };
    if (loadingMessages && loadingMessages.length > 0) {
      body.loading_messages = loadingMessages;
    }
    const result = await slackApiCall('assistant.threads.setStatus', body, ctx.token);
    if (!result.ok) {
      console.error(`[SlackTransport] setThreadStatus error: ${result.error}`);
    }
    return result.ok;
  }

  /**
   * Set suggested prompts for an assistant thread.
   */
  async setSuggestedPrompts(
    target: ChannelTarget,
    prompts: Array<{ title: string; message: string }>,
    ctx: ChannelContext,
    title?: string,
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      channel_id: target.channelId,
      thread_ts: target.threadId,
      prompts,
    };
    if (title) body.title = title;

    const result = await slackApiCall('assistant.threads.setSuggestedPrompts', body, ctx.token);
    if (!result.ok) {
      console.error(`[SlackTransport] setSuggestedPrompts error: ${result.error}`);
    }
    return result.ok;
  }

  async resolveLabel(channelId: string, ctx: ChannelContext): Promise<string> {
    // Composite channelId comes in several formats:
    //   3-part: "teamId:slackChannelId:threadTs" (from scopeKeyParts)
    //   2-part: "slackChannelId:threadTs" (from dispatch encoding)
    //   1-part: bare channelId or threadTs
    // Slack channel IDs start with a letter (C/D/G/W), thread timestamps are numeric (e.g. "1773177297.231269").
    const parts = channelId.split(':');
    let slackChannelId: string | undefined;
    let hasThread = false;

    const isSlackId = (s: string) => /^[A-Z]/.test(s);
    const isThreadTs = (s: string) => /^\d+\.\d+$/.test(s);

    if (parts.length >= 3) {
      // teamId:channelId:threadTs
      slackChannelId = isSlackId(parts[1]) ? parts[1] : undefined;
      hasThread = isThreadTs(parts[2]);
    } else if (parts.length === 2) {
      // channelId:threadTs or teamId:channelId
      if (isSlackId(parts[0]) && isThreadTs(parts[1])) {
        slackChannelId = parts[0];
        hasThread = true;
      } else if (isSlackId(parts[1])) {
        slackChannelId = parts[1];
      } else if (isSlackId(parts[0])) {
        slackChannelId = parts[0];
      }
    } else if (isSlackId(parts[0])) {
      slackChannelId = parts[0];
    } else if (isThreadTs(parts[0])) {
      // Bare threadTs with no channel ID — can only infer it's a thread
      return 'Slack DM (thread)';
    }

    if (!slackChannelId) {
      return hasThread ? 'Slack (thread)' : 'Slack';
    }

    // Try to resolve channel name via conversations.info
    let channelName: string | undefined;
    try {
      const result = await slackApiGet('conversations.info', { channel: slackChannelId }, ctx.token);
      if (result.ok) {
        const channel = result.channel as Record<string, unknown> | undefined;
        if (channel) {
          const isDm = channel.is_im === true;
          const isMpim = channel.is_mpim === true;
          if (isDm) {
            channelName = 'DM';
          } else if (isMpim) {
            channelName = (channel.name_normalized as string) || (channel.name as string) || 'Group DM';
          } else {
            channelName = (channel.name_normalized as string) || (channel.name as string);
          }
        }
      }
    } catch {
      // Fall back to ID-based heuristic
    }

    // Fallback: detect type from channel ID prefix
    if (!channelName) {
      if (slackChannelId.startsWith('D')) {
        channelName = 'DM';
      } else if (slackChannelId.startsWith('G')) {
        channelName = 'Group DM';
      } else {
        channelName = slackChannelId;
      }
    }

    const suffix = hasThread ? ' (thread)' : '';
    if (channelName === 'DM' || channelName === 'Group DM') {
      return `Slack ${channelName}${suffix}`;
    }
    return `Slack #${channelName}${suffix}`;
  }

  // Slack has no bot typing indicator API
  // sendTypingIndicator is intentionally omitted

  // Slack Events API URL is configured in app settings, not per-user
  // registerWebhook / unregisterWebhook are intentionally omitted

  // ─── Interactive Prompts ────────────────────────────────────────────

  async sendInteractivePrompt(
    target: ChannelTarget,
    prompt: InteractivePrompt,
    ctx: ChannelContext,
  ): Promise<InteractivePromptRef | null> {
    // If no actions, send plain text prompt for thread-reply input
    if (!prompt.actions || prompt.actions.length === 0) {
      const text = `*${prompt.title}*${prompt.body ? '\n' + prompt.body : ''}\n_Reply to this thread with your answer._`;
      const body: Record<string, unknown> = {
        channel: target.channelId,
        text: this.formatMarkdown(text),
        unfurl_links: false,
      };
      if (target.threadId) body.thread_ts = target.threadId;

      const result = await slackApiCall('chat.postMessage', body, ctx.token);
      if (!result.ok) {
        console.error(`[SlackTransport] sendInteractivePrompt (text) error: ${result.error}`);
        return null;
      }
      return { messageId: result.ts!, channelId: target.channelId };
    }

    // Build Block Kit message with buttons
    const blocks: Record<string, unknown>[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${prompt.title}*${prompt.body ? '\n' + prompt.body : ''}`,
        },
      },
    ];

    if (prompt.expiresAt) {
      const expiryUnix = Math.floor(prompt.expiresAt / 1000);
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Expires <!date^${expiryUnix}^{date_short_pretty} at {time}|soon>`,
          },
        ],
      });
    }

    // Encode sessionId:promptId in value so the interactive route can find the DO
    // without requiring a D1 lookup (question prompts don't exist in D1)
    const buttonValue = prompt.sessionId ? `${prompt.sessionId}:${prompt.id}` : prompt.id;

    blocks.push({
      type: 'actions',
      elements: prompt.actions.map((action) => ({
        type: 'button',
        text: { type: 'plain_text' as const, text: action.label },
        ...(action.style ? { style: action.style } : {}),
        action_id: action.id,
        value: buttonValue,
      })),
    });

    const body: Record<string, unknown> = {
      channel: target.channelId,
      text: prompt.title,
      blocks,
      unfurl_links: false,
    };
    if (target.threadId) body.thread_ts = target.threadId;

    const result = await slackApiCall('chat.postMessage', body, ctx.token);
    if (!result.ok) {
      console.error(`[SlackTransport] sendInteractivePrompt error: ${result.error}`);
      return null;
    }
    return { messageId: result.ts!, channelId: target.channelId };
  }

  async updateInteractivePrompt(
    _target: ChannelTarget,
    ref: InteractivePromptRef,
    resolution: InteractiveResolution,
    ctx: ChannelContext,
  ): Promise<void> {
    let statusText: string;
    if (resolution.actionId === '__expired__') {
      statusText = '⏰ Expired';
    } else if (resolution.actionId === 'approve') {
      statusText = `✅ Approved by ${resolution.resolvedBy}`;
    } else if (resolution.actionId === 'deny') {
      statusText = `❌ Denied by ${resolution.resolvedBy}`;
      if (resolution.value) statusText += `: ${resolution.value}`;
    } else if (resolution.actionLabel || resolution.actionId) {
      const label = resolution.actionLabel || resolution.actionId;
      statusText = `*${label}* — selected by ${resolution.resolvedBy}`;
    } else if (resolution.value) {
      const preview = resolution.value.length > 100
        ? resolution.value.slice(0, 97) + '...'
        : resolution.value;
      statusText = `Answered by ${resolution.resolvedBy}: ${preview}`;
    } else {
      statusText = `Resolved by ${resolution.resolvedBy}`;
    }

    // Prepend original question for context
    if (resolution.promptTitle) {
      statusText = `${resolution.promptTitle}\n\n${statusText}`;
    }

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: statusText } },
    ];

    const result = await slackApiCall('chat.update', {
      channel: ref.channelId,
      ts: ref.messageId,
      text: statusText,
      blocks,
    }, ctx.token);

    if (!result.ok) {
      console.error(`[SlackTransport] updateInteractivePrompt error: ${result.error}`);
    }
  }
}
