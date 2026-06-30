import { describe, expect, it } from 'vitest';
import { getToolCardMeta } from './meta';

describe('getToolCardMeta', () => {
  it('uses lightweight summaries for common filesystem tools', () => {
    expect(
      getToolCardMeta({
        toolName: 'mcp__ide__read',
        status: 'completed',
        args: { file_path: 'packages/client/src/app.tsx' },
        result: null,
      })
    ).toEqual({
      label: 'read',
      summary: 'packages/client/src/app.tsx',
    });

    expect(
      getToolCardMeta({
        toolName: 'bash',
        status: 'completed',
        args: { description: 'Run typecheck', command: 'pnpm typecheck' },
        result: null,
      })
    ).toEqual({
      label: 'bash',
      summary: 'Run typecheck',
    });
  });

  it('falls back safely for unknown tools', () => {
    expect(
      getToolCardMeta({
        toolName: 'unknown_tool',
        status: 'completed',
        args: {},
        result: null,
      })
    ).toEqual({
      label: 'unknown_tool',
    });
  });

  it('surfaces arg + result count for unknown list-style tools', () => {
    expect(
      getToolCardMeta({
        toolName: 'list_tools',
        status: 'completed',
        args: { query: 'trigger' },
        result: JSON.stringify([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]),
      })
    ).toEqual({
      label: 'list_tools',
      summary: 'trigger · 4 results',
    });
  });

  it('surfaces service-scoped args even when query is absent', () => {
    expect(
      getToolCardMeta({
        toolName: 'list_tools',
        status: 'completed',
        args: { service: 'workflows' },
        result: JSON.stringify([{ id: 'a' }, { id: 'b' }]),
      })
    ).toEqual({
      label: 'list_tools',
      summary: 'workflows · 2 results',
    });
  });

  it('combines call_tool dispatch target with result count', () => {
    expect(
      getToolCardMeta({
        toolName: 'call_tool',
        status: 'completed',
        args: { tool_id: 'workflows:workflows.list' },
        result: JSON.stringify({ workflows: [{ id: '1' }, { id: '2' }] }),
      })
    ).toEqual({
      label: 'call_tool',
      summary: 'workflows:workflows.list · 2 workflows',
    });
  });
});
