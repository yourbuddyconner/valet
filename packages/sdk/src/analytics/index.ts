/**
 * Analytics interface for plugins to emit custom events.
 *
 * Events are fire-and-forget — emit() never throws or blocks.
 * The system automatically injects session_id, user_id, turn_id,
 * channel, and created_at. Plugins only specify what they uniquely know.
 *
 * Convention: namespace event types as `{plugin}.{event}`:
 *   analytics.emit('github.pr_created', { durationMs: 340 })
 *   analytics.emit('slack.message_sent', { properties: { channel: '#general' } })
 */
export interface Analytics {
  emit(eventType: string, data?: {
    durationMs?: number;
    properties?: Record<string, unknown>;
  }): void;
}

/**
 * No-op analytics implementation for contexts where analytics is not available.
 */
export const noopAnalytics: Analytics = {
  emit() {},
};
