/**
 * channel-resolver — deterministic channel lookup for outbound emissions.
 *
 * Every outbound emission (error, question, screenshot, status, approval, etc.)
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
}

export type DropReason =
  | 'unmapped_session'
  | 'no_message_id'
  | 'no_prompt_row'
  | 'no_session_id';

/**
 * Resolve the channel target for an outbound emission by looking up the
 * prompt_queue row for the given messageId via `promptQueue.getChannelTargetById`.
 *
 * Returns null if the row is missing or lacks both channelType and channelId.
 * Callers MUST handle null explicitly — do NOT fall back to mutable state.
 */
export function getChannelForMessage(
  promptQueue: PromptQueue,
  messageId: string,
): ChannelTarget | null {
  const row = promptQueue.getChannelTargetById(messageId);
  if (!row) return null;
  if (!row.channelType || !row.channelId) return null;
  return { channelType: row.channelType, channelId: row.channelId };
}

/** Log a structured warning when an emission is dropped due to missing routing. */
export function dropEmission(reason: DropReason, ctx: Record<string, unknown>): void {
  console.warn('[ChannelRouting] dropped emission', { reason, ...ctx });
}
