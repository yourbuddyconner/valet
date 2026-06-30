import { decode as decodeToon } from '@toon-format/toon';
import { ToolCardShell, ToolCardSection, ToolCodeBlock } from './tool-card-shell';
import { MessageIcon } from './icons';
import type { ToolCallData } from './types';

interface SendMessageArgs {
  session_id?: string;
  message?: string;
}

interface ReadMessagesArgs {
  session_id?: string;
  limit?: number;
  after?: string;
}

export function SendMessageCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as SendMessageArgs;
  const targetId = args.session_id?.slice(0, 8);
  const message = args.message;

  return (
    <ToolCardShell
      icon={<MessageIcon className="h-3.5 w-3.5" />}
      label="send_message"
      status={tool.status}
      tool={tool}
      summary={
        targetId ? (
          <span className="text-neutral-500 dark:text-neutral-400">
            to {targetId}...
          </span>
        ) : undefined
      }
    >
      {message && (
        <ToolCardSection label="message">
          <p className="font-mono text-[11px] leading-[1.6] text-neutral-600 dark:text-neutral-400">
            {message.length > 300 ? message.slice(0, 300) + '...' : message}
          </p>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

export function ReadMessagesCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as ReadMessagesArgs;
  const targetId = args.session_id?.slice(0, 8);

  // Parse result messages
  const messages = parseMessages(tool.result);

  return (
    <ToolCardShell
      icon={<MessageIcon className="h-3.5 w-3.5" />}
      label="read_messages"
      status={tool.status}
      tool={tool}
      defaultExpanded={Boolean(messages) || (tool.status === 'completed' && typeof tool.result === 'string')}
      summary={
        targetId ? (
          <span className="text-neutral-500 dark:text-neutral-400">
            from {targetId}...
            {messages && <span className="ml-1">({messages.length} msgs)</span>}
          </span>
        ) : undefined
      }
    >
      {messages && messages.length > 0 && (
        <ToolCardSection label={`${messages.length} messages`}>
          <div className="max-h-[240px] space-y-2 overflow-auto">
            {messages.map((msg, i) => (
              <div key={msg.id || i} className="rounded border border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
                <div className="mb-1 flex items-start gap-2 font-mono text-[11px]">
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase ${
                    msg.role === 'assistant'
                      ? 'bg-accent/10 text-accent'
                      : msg.role === 'user'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                        : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                  }`}>
                    {msg.role}
                  </span>
                  <span className="min-w-0 flex-1 break-all text-neutral-600 dark:text-neutral-400">
                    {msg.content}
                  </span>
                </div>
                {msg.parts !== undefined && (
                  <ToolCodeBlock maxHeight="160px" className="border-t border-neutral-100 pt-1 text-[10px] dark:border-neutral-800">
                    {JSON.stringify(msg.parts, null, 2)}
                  </ToolCodeBlock>
                )}
              </div>
            ))}
          </div>
        </ToolCardSection>
      )}

      {messages && messages.length === 0 && (
        <ToolCardSection>
          <p className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
            No messages found
          </p>
        </ToolCardSection>
      )}

      {!messages && tool.status === 'completed' && typeof tool.result === 'string' && (
        <ToolCardSection label="result">
          <ToolCodeBlock maxHeight="320px">
            {tool.result}
          </ToolCodeBlock>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

type ReadMessageResult = {
  id?: string;
  sessionId?: string;
  role: string;
  content: string;
  parts?: unknown;
  authorId?: string;
  authorEmail?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  threadId?: string;
  createdAt: string;
};

export function parseMessages(result: unknown): ReadMessageResult[] | null {
  if (Array.isArray(result)) return isReadMessageArray(result) ? result : null;
  if (typeof result !== 'string') return null;
  try {
    const parsed = JSON.parse(result);
    if (isReadMessageArray(parsed)) return parsed;
  } catch {
    try {
      const parsed = decodeToon(result);
      if (isReadMessageArray(parsed)) return parsed;
    } catch {
      // Not a structured message payload
    }
  }
  return null;
}

function isReadMessageArray(value: unknown): value is ReadMessageResult[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    return typeof row.role === 'string'
      && typeof row.content === 'string'
      && typeof row.createdAt === 'string';
  });
}
