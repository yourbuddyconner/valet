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

  switch (baseName) {
    case 'read':
    case 'readfile':
      return {
        label: 'Read',
        summary: asString(args?.file_path) ?? asString(args?.filePath),
      };
    case 'edit':
    case 'editfile':
      return {
        label: 'Edit',
        summary: asString(args?.file_path) ?? asString(args?.filePath),
      };
    case 'write':
    case 'writefile':
    case 'createfile':
      return {
        label: 'Write',
        summary: asString(args?.file_path) ?? asString(args?.filePath),
      };
    case 'bash':
    case 'shell':
    case 'execute':
    case 'executecode':
    case 'run':
      return {
        label: 'Bash',
        summary: asString(args?.description) ?? asString(args?.command),
      };
    case 'grep':
    case 'search':
    case 'ripgrep':
    case 'content_search':
      return {
        label: 'Grep',
        summary: asString(args?.pattern),
      };
    case 'glob':
    case 'find':
    case 'find_files':
    case 'file_search':
      return {
        label: 'Glob',
        summary: asString(args?.pattern) ?? asString(args?.path),
      };
    case 'patch':
    case 'apply_patch':
      return {
        label: 'Patch',
        summary: asString(args?.file_path) ?? asString(args?.filePath),
      };
    case 'webfetch':
    case 'web_fetch':
    case 'fetch_url':
      return {
        label: 'Fetch',
        summary: asString(args?.url),
      };
    case 'list':
    case 'list_dir':
    case 'list_directory':
    case 'ls':
      return {
        label: 'List',
        summary: asString(args?.path),
      };
    case 'question':
    case 'ask':
    case 'ask_user':
      return {
        label: 'Question',
        summary: asString(args?.question) ?? asString(args?.header),
      };
    case 'todowrite':
    case 'todo_write':
    case 'write_todos':
      return {
        label: 'Todo',
        summary: 'Update todos',
      };
    case 'todoread':
    case 'todo_read':
    case 'read_todos':
    case 'list_todos':
      return {
        label: 'Todo',
        summary: 'Read todos',
      };
    case 'lsp':
    case 'language_server':
      return {
        label: 'LSP',
        summary: asString(args?.operation) ?? asString(args?.symbol) ?? asString(args?.query),
      };
    case 'skill':
    case 'load_skill':
      return {
        label: 'Skill',
        summary: asString(args?.name) ?? asString(args?.path),
      };
    case 'task':
    case 'subagent':
      return {
        label: 'Task',
        summary: asString(args?.description) ?? asString(args?.prompt),
      };
    case 'spawn_session':
    case 'spawnsession':
      return {
        label: 'Session',
        summary: 'Spawn session',
      };
    case 'send_message':
    case 'sendmessage':
      return {
        label: 'Message',
        summary: 'Send message',
      };
    case 'read_messages':
    case 'readmessages':
      return {
        label: 'Messages',
        summary: 'Read messages',
      };
    default:
      return {
        label: tool.toolName,
      };
  }
}
