/**
 * Convert standard Markdown to Slack's mrkdwn format.
 * Handles: fenced code blocks, inline code, bold, italic, links, blockquotes.
 */
export function markdownToSlackMrkdwn(text: string): string {
  // Extract fenced code blocks first to protect them from formatting transforms
  const codeBlocks: string[] = [];
  let result = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_, code: string) => {
    codeBlocks.push(code.trimEnd());
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Extract inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Convert bold to placeholders first (so italic pass doesn't re-match)
  // **bold** or __bold__ → placeholder
  const boldSpans: string[] = [];
  result = result.replace(/\*\*(.+?)\*\*/g, (_, content: string) => {
    boldSpans.push(content);
    return `\x00BD${boldSpans.length - 1}\x00`;
  });
  result = result.replace(/__(.+?)__/g, (_, content: string) => {
    boldSpans.push(content);
    return `\x00BD${boldSpans.length - 1}\x00`;
  });

  // *italic* → _italic_ (safe now since bold ** has been extracted)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');

  // [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Restore bold spans as Slack bold (*text*)
  result = result.replace(/\x00BD(\d+)\x00/g, (_, i) => {
    return `*${boldSpans[Number(i)]}*`;
  });

  // Restore inline code
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i) => {
    return `\`${inlineCodes[Number(i)]}\``;
  });

  // Restore code blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i) => {
    return `\`\`\`${codeBlocks[Number(i)]}\`\`\``;
  });

  return result;
}
