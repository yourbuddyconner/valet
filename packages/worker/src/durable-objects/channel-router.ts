/**
 * ChannelRouter — reply tracking and delivery orchestration.
 *
 * Owns the in-memory state for whether the current prompt cycle should auto-reply
 * to an originating channel on turn completion.
 *
 * Stateless across prompt cycles — scoped to a single turn. The DO is responsible
 * for calling `trackReply()` at prompt dispatch time and `consumePendingReply()`
 * at turn completion.
 *
 * Does NOT own: token resolution, transport sending, channel_followups persistence,
 * shimmer clearing, or any SQLite tables.
 */

// FUTURE: dispatch channel transport lifecycle hook here (onTurnStarted, onTurnFinalized)

export interface PendingReply {
  channelType: string;
  channelId: string;
  resultContent: string | null;
  resultMessageId: string | null;
  handled: boolean;
}

export interface ReplyIntent {
  channelType: string;
  channelId: string;
  content: string;
  messageId: string;
}

export class ChannelRouter {
  private pending: PendingReply | null = null;

  /**
   * Track that the current prompt expects a reply to this channel.
   * Called at prompt dispatch time (both direct and queued paths).
   */
  trackReply(replyTo: { channelType: string; channelId: string }): void {
    this.pending = {
      channelType: replyTo.channelType,
      channelId: replyTo.channelId,
      resultContent: null,
      resultMessageId: null,
      handled: false,
    };
  }

  /**
   * Mark a channel as handled (agent explicitly called channel_reply).
   * Prevents auto-reply via consumePendingReply().
   */
  markHandled(channelType: string, channelId: string): void {
    if (
      this.pending &&
      this.pending.channelType === channelType &&
      this.pending.channelId === channelId
    ) {
      this.pending.handled = true;
    }
  }

  /**
   * Attach the agent's response content to the pending reply.
   * Called on finalizeTurn when the assistant message has content.
   */
  setResult(content: string, messageId: string): void {
    if (this.pending && !this.pending.handled) {
      this.pending.resultContent = content;
      this.pending.resultMessageId = messageId;
    }
  }

  /**
   * Consume the pending reply on turn complete.
   * Returns the reply intent if the agent didn't handle it explicitly,
   * or null if no reply is needed.
   * Clears internal state — call only once per prompt cycle.
   */
  consumePendingReply(): ReplyIntent | null {
    const pending = this.pending;
    this.pending = null;

    if (!pending || pending.handled || !pending.resultContent || !pending.resultMessageId) {
      return null;
    }

    return {
      channelType: pending.channelType,
      channelId: pending.channelId,
      content: pending.resultContent,
      messageId: pending.resultMessageId,
    };
  }

  /**
   * Recover reply tracking state after hibernation.
   * The DO provides the channel info from the prompt_queue processing row.
   */
  recover(channelType: string, channelId: string): void {
    this.pending = {
      channelType,
      channelId,
      resultContent: null,
      resultMessageId: null,
      handled: false,
    };
  }

  /** Whether there is a pending reply being tracked. */
  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** The current pending reply state (read-only snapshot). Null if none. */
  get pendingSnapshot(): Readonly<PendingReply> | null {
    return this.pending ? { ...this.pending } : null;
  }

  /** Reset all state. Called on dispatch failure or explicit clear. */
  clear(): void {
    this.pending = null;
  }
}
