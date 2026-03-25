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
      label: 'Read',
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
      label: 'Bash',
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
});
