/**
 * channel-resolver — deterministic channel lookup for outbound emissions.
 *
 * Every outbound emission (error, question, image, status, approval, etc.)
 * must carry the messageId of the prompt it belongs to. This helper resolves
 * the channel attribution from the prompt_queue row for that messageId.
 *
 * This is the single source of truth for outbound channel routing. Callers
 * MUST NOT fall back to mutable cursor state (e.g. `activeChannel`) when
 * this returns null — drop the emission with `dropEmission(...)` instead.
 */

import type { PromptQueue } from './prompt-queue.js';

export interface ChannelTarget {
  channelType: string;
  channelId: string;
  threadId?: string | null;
}

export type DropReason =
  | 'unmapped_session'
  | 'no_message_id'
  | 'no_prompt_row'
  | 'row_without_channel'
  | 'no_session_id';

export type ChannelLookupResult =
  | { found: true; target: ChannelTarget }
  | { found: false; reason: 'no_prompt_row' | 'row_without_channel' };

/**
 * Resolve the channel target for an outbound emission by looking up the
 * prompt_queue row for the given messageId via `promptQueue.getChannelTargetById`.
 *
 * Returns a discriminated result so callers can distinguish "row missing"
 * (prompt already completed / never existed) from "row exists but has no
 * channel" (e.g. system prompts on orchestrator sessions).
 */
export function getChannelForMessage(
  promptQueue: PromptQueue,
  messageId: string,
): ChannelLookupResult {
  const row = promptQueue.getChannelTargetById(messageId);
  if (!row) return { found: false, reason: 'no_prompt_row' };
  if (!row.channelType || !row.channelId) return { found: false, reason: 'row_without_channel' };
  return { found: true, target: { channelType: row.channelType, channelId: row.channelId, threadId: row.threadId } };
}

/** Log a structured warning when an emission is dropped due to missing routing. */
export function dropEmission(reason: DropReason, ctx: Record<string, unknown>): void {
  console.warn('[ChannelRouting] dropped emission', { reason, ...ctx });
}
