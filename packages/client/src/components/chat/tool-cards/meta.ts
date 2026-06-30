import type { ToolCallData } from './types';

export interface ToolCardMeta {
  label: string;
  summary?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toolBaseName(toolName: string): string {
  return toolName.toLowerCase().split('__').pop()?.split('.').pop() ?? toolName.toLowerCase();
}

export function getToolCardMeta(tool: ToolCallData): ToolCardMeta {
  const baseName = toolBaseName(tool.toolName);
  const args = asRecord(tool.args);

  // Labels are kept in lowercase to match the specialized card labels —
  // when the specialized chunk lazy-loads, the Suspense fallback (the
  // summary card) and the specialized card show the same label, so the
  // header doesn't visibly morph during load.
  switch (baseName) {
    case 'read':
    case 'readfile':
      return {
        label: 'read',
        summary: asString(args?.file_path) ?? asString(args?.filePath),
      };
    case 'edit':
    case 'editfile':
      return {
        label: 'edit',
        summary: asString(args?.file_path) ?? asString(args?.filePath),
      };
    case 'write':
    case 'writefile':
    case 'createfile':
      return {
        label: 'write',
        summary: asString(args?.file_path) ?? asString(args?.filePath),
      };
    case 'bash':
    case 'shell':
    case 'execute':
    case 'executecode':
    case 'run':
      return {
        label: 'bash',
        summary: asString(args?.description) ?? asString(args?.command),
      };
    case 'grep':
    case 'search':
    case 'ripgrep':
    case 'content_search':
      return {
        label: 'grep',
        summary: asString(args?.pattern),
      };
    case 'glob':
    case 'find':
    case 'find_files':
    case 'file_search':
      return {
        label: 'glob',
        summary: asString(args?.pattern) ?? asString(args?.path),
      };
    case 'patch':
    case 'apply_patch':
      return {
        label: 'patch',
        summary: asString(args?.file_path) ?? asString(args?.filePath),
      };
    case 'webfetch':
    case 'web_fetch':
    case 'fetch_url':
      return {
        label: 'webfetch',
        summary: asString(args?.url),
      };
    case 'list':
    case 'list_dir':
    case 'list_directory':
    case 'ls':
      return {
        label: 'ls',
        summary: asString(args?.path),
      };
    case 'question':
    case 'ask':
    case 'ask_user':
      return {
        label: 'question',
        summary: asString(args?.question) ?? asString(args?.header),
      };
    case 'todowrite':
    case 'todo_write':
    case 'write_todos':
      return {
        label: 'todowrite',
        summary: 'Update todos',
      };
    case 'todoread':
    case 'todo_read':
    case 'read_todos':
    case 'list_todos':
      return {
        label: 'todoread',
        summary: 'Read todos',
      };
    case 'lsp':
    case 'language_server':
      return {
        label: 'lsp',
        summary: asString(args?.operation) ?? asString(args?.symbol) ?? asString(args?.query),
      };
    case 'skill':
    case 'load_skill':
      return {
        label: 'skill',
        summary: asString(args?.name) ?? asString(args?.path),
      };
    case 'task':
    case 'subagent':
      return {
        label: 'task',
        summary: asString(args?.description) ?? asString(args?.prompt),
      };
    case 'spawn_session':
    case 'spawnsession':
      return {
        label: 'spawn_session',
        summary: 'Spawn session',
      };
    case 'send_message':
    case 'sendmessage':
      return {
        label: 'send_message',
        summary: 'Send message',
      };
    case 'read_messages':
    case 'readmessages':
      return {
        label: 'read_messages',
        summary: 'Read messages',
      };
    default:
      return {
        label: tool.toolName,
      };
  }
}
