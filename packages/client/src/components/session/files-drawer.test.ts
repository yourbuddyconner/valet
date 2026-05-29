import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FilesDrawer } from './files-drawer';

vi.mock('@/hooks/use-drawer', () => ({
  useDrawer: () => ({
    clearPendingFile: vi.fn(),
    closeDrawer: vi.fn(),
    pendingFilePath: 'long-line.md',
  }),
}));

vi.mock('@/api/sessions', () => ({
  useSession: () => ({
    data: {
      status: 'running',
    },
  }),
}));

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/components/files/file-browser', async () => {
  const React = await import('react');

  return {
    FileBrowser: () => React.createElement('div', { 'data-file-browser': 'true' }),
  };
});

describe('FilesDrawer', () => {
  it('does not let file content widen the drawer panel', () => {
    const html = renderToStaticMarkup(
      createElement(FilesDrawer, {
        sessionId: 'session-123',
      })
    );

    expect(html).toContain('flex h-full min-w-0 flex-col overflow-hidden');
    expect(html).toContain('min-h-0 min-w-0 flex-1 overflow-hidden');
  });
});
