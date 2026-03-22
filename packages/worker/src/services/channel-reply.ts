/**
 * sendChannelReply — auto-reply dispatch for text-only channel replies.
 *
 * Handles transport resolution and message sending only.
 *
 * Does NOT:
 * - Stamp messages with channel delivery metadata (caller does via MessageStore)
 * - Broadcast message.updated to WebSocket clients (caller does)
 * - Persist followup state (caller does)
 * - Resolve persona or tokens (caller passes via ctx)
 * - Handle file/image attachments (handleChannelReply does)
 */

import type { ChannelContext, ChannelTarget, SendResult } from '@valet/sdk';
import { channelRegistry } from '../channels/registry.js';

export interface ReplyPayload {
  channelType: string;
  channelId: string;
  content: string;
  messageId: string;
}

/**
 * Parse a composite channelId (e.g., "C123:thread_ts" for Slack) into
 * a ChannelTarget with separate channelId and threadId.
 */
function parseCompositeChannelId(channelType: string, channelId: string): ChannelTarget {
  if (channelType === 'slack' && channelId.includes(':')) {
    const idx = channelId.indexOf(':');
    return { channelType, channelId: channelId.slice(0, idx), threadId: channelId.slice(idx + 1) };
  }
  return { channelType, channelId };
}

/**
 * Send a text-only auto-reply to a channel.
 *
 * Returns true on success, false on failure.
 * The caller is responsible for post-send actions (stamping, broadcasting, followups).
 */
export async function sendChannelReply(
  reply: ReplyPayload,
  ctx: ChannelContext,
): Promise<boolean> {
  const transport = channelRegistry.getTransport(reply.channelType);
  if (!transport) {
    console.log(`[sendChannelReply] Unsupported channel type: ${reply.channelType}`);
    return false;
  }

  const target = parseCompositeChannelId(reply.channelType, reply.channelId);
  const outbound = { markdown: reply.content };

  try {
    const result: SendResult = await transport.sendMessage(target, outbound, ctx);
    if (result.success) {
      console.log(`[sendChannelReply] Sent to ${reply.channelType}:${reply.channelId}`);
      return true;
    }
    console.error(`[sendChannelReply] Failed for ${reply.channelType}:${reply.channelId}: ${result.error}`);
    return false;
  } catch (err) {
    console.error('[sendChannelReply] Error:', err);
    return false;
  }
}
