import type { Message, MessagePart, ToolCallPart } from '@valet/shared';

function formatToolCall(part: ToolCallPart): string {
  const lines: string[] = [];
  lines.push(`  [tool] ${part.toolName} (${part.status})`);
  if (part.args != null) {
    const argsStr = typeof part.args === 'string' ? part.args : JSON.stringify(part.args, null, 2);
    lines.push(`  ARGS:`);
    for (const line of argsStr.split('\n')) lines.push(`    ${line}`);
  }
  if (part.result != null) {
    const resultStr = typeof part.result === 'string' ? part.result : JSON.stringify(part.result, null, 2);
    lines.push(`  RESULT:`);
    for (const line of resultStr.split('\n')) lines.push(`    ${line}`);
  }
  if (part.error) {
    lines.push(`  ERROR: ${part.error}`);
  }
  return lines.join('\n');
}

function formatPart(part: MessagePart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'tool-call':
      return formatToolCall(part);
    case 'error':
      return `[error] ${part.message}`;
    case 'finish':
      return '';
    default:
      return '';
  }
}

interface TranscriptIds {
  sessionId: string;
  threadId?: string;
}

export function exportTranscript(
  title: string,
  messages: Message[],
  ids: TranscriptIds,
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push(`Session: ${ids.sessionId}`);
  if (ids.threadId) lines.push(`Thread: ${ids.threadId}`);
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push(`Messages: ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const timestamp = new Date(msg.createdAt).toISOString();
    const author = msg.authorName || msg.authorEmail || msg.role;
    lines.push(`## [${msg.role.toUpperCase()}] ${author} — ${timestamp}`);
    lines.push('');

    if (msg.parts && msg.parts.length > 0) {
      for (const part of msg.parts) {
        const formatted = formatPart(part);
        if (formatted) {
          lines.push(formatted);
          lines.push('');
        }
      }
    } else if (msg.content) {
      lines.push(msg.content);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export function downloadTranscript(title: string, messages: Message[], ids: TranscriptIds) {
  const content = exportTranscript(title, messages, ids);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const idSuffix = ids.threadId ? ids.threadId.slice(0, 8) : ids.sessionId.slice(0, 8);
  const filename = `${slug}-${idSuffix}.txt`;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
