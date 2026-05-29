import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FileBrowser } from './file-browser';

vi.mock('@/api/files', () => ({
  useFileList: () => ({
    data: {
      files: [
        {
          name: 'long-line.md',
          path: 'long-line.md',
          type: 'file',
        },
      ],
    },
    isLoading: false,
  }),
  useFileSearch: () => ({
    data: undefined,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('./file-preview', async () => {
  const React = await import('react');

  return {
    FilePreview: () => React.createElement('div', { 'data-file-preview': 'true' }),
  };
});

describe('FileBrowser', () => {
  it('allows the file preview column to shrink inside the session drawer', () => {
    const html = renderToStaticMarkup(
      createElement(FileBrowser, {
        sessionId: 'session-123',
        initialFilePath: 'long-line.md',
      })
    );

    expect(html).toContain('flex h-full min-w-0 flex-col overflow-hidden');
    expect(html).toContain('flex min-h-0 min-w-0 flex-1 overflow-hidden');
  });
});
