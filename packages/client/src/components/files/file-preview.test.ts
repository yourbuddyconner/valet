import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FilePreview } from './file-preview';

const mockUseFileRead = vi.hoisted(() => vi.fn());

vi.mock('@/api/files', () => ({
  useFileRead: mockUseFileRead,
}));

vi.mock('@/hooks/use-pierre-theme', () => ({
  usePierreTheme: () => 'github-light',
}));

vi.mock('@pierre/diffs/react', () => ({
  File: () => null,
}));

describe('FilePreview', () => {
  it('keeps raw file previews inside a local scroll container', () => {
    mockUseFileRead.mockReturnValue({
      data: {
        content: `const longLine = '${'x'.repeat(240)}';`,
        path: 'long-line.txt',
      },
      isError: false,
      isLoading: false,
    });

    const html = renderToStaticMarkup(
      createElement(FilePreview, {
        sessionId: 'session-123',
        path: 'long-line.txt',
      })
    );

    expect(html).toContain('min-h-0 min-w-0 flex-1 overflow-auto');
  });
});
