/**
 * Slack limits: chat.postMessage text field ≤ 4000 chars, section block text
 * ≤ 3000 chars, markdown block ≤ 12000 chars cumulative, max 50 blocks per
 * message. For long messages we use blocks inside a single API call (no extra
 * rate-limit cost) instead of sending multiple messages (which violates the
 * 1 msg/sec/channel rate limit and risks silent message loss).
 *
 * Preferred block type is `markdown` — it renders standard markdown natively
 * (tables, headers, code blocks, etc.) without needing mrkdwn conversion.
 * Falls back to `section` blocks for messages exceeding the markdown limit.
 */

/** Max characters in the `text` field of chat.postMessage before we switch to blocks. */
export const SLACK_TEXT_LIMIT = 4000;

/** Cumulative character limit across all markdown blocks in a single payload. */
export const SLACK_MARKDOWN_LIMIT = 12000;

/** Max characters in a single section block's text element. */
export const SLACK_BLOCK_TEXT_LIMIT = 3000;

/** Slack allows at most 50 blocks per message. */
export const SLACK_MAX_BLOCKS = 50;

/**
 * Split text into chunks at paragraph boundaries, keeping each chunk under maxLen.
 * Falls back to single-newline splits, then hard-splits at maxLen.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find the last paragraph break (\n\n) within the limit.
    // splitIdx === 0 means the only match is at the very start — slice(0,0) would
    // produce an empty chunk, so treat it the same as not-found and fall through.
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }

  return chunks;
}

/**
 * Build content blocks for a message. Prefers a single `markdown` block (which
 * renders tables, headers, code blocks natively). Falls back to `section` blocks
 * with mrkdwn for messages exceeding the markdown cumulative limit.
 *
 * @param text Raw markdown text (NOT pre-converted to Slack mrkdwn).
 * @param mrkdwnText Slack mrkdwn-formatted text, used only for section block fallback.
 * @param maxBlocks Cap the number of blocks returned.
 */
export function buildContentBlocks(
  text: string,
  mrkdwnText: string,
  maxBlocks: number = SLACK_MAX_BLOCKS,
): Record<string, unknown>[] {
  if (text.length <= SLACK_MARKDOWN_LIMIT) {
    return [{ type: 'markdown', text }];
  }

  // Fallback: split mrkdwn-formatted text into section blocks
  const chunks = splitText(mrkdwnText, SLACK_BLOCK_TEXT_LIMIT);
  return chunks.slice(0, maxBlocks).map((chunk) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: chunk },
  }));
}
