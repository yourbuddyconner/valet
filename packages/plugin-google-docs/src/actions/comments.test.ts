import { describe, it, expect, vi, beforeEach } from 'vitest';
import { googleDocsActions } from './actions.js';
import type { ActionContext } from '@valet/sdk';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeCtx(): ActionContext {
  return {
    credentials: { access_token: 'test-token' },
    userId: 'test-user',
  } as ActionContext;
}

function okResponse(data: unknown = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('docs.list_comments', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('lists unresolved comments by default', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({
        comments: [
          {
            id: 'c1',
            content: 'Fix this typo',
            author: { displayName: 'Zeke', emailAddress: 'zeke@example.com' },
            resolved: false,
            quotedFileContent: { mimeType: 'text/html', value: 'teh system' },
            replies: [],
          },
          {
            id: 'c2',
            content: 'Already addressed',
            author: { displayName: 'Zeke', emailAddress: 'zeke@example.com' },
            resolved: true,
            replies: [{ id: 'r1', content: 'Done', author: { displayName: 'Agent' }, action: 'resolve' }],
          },
        ],
      }),
    );

    const result = await googleDocsActions.execute(
      'docs.list_comments',
      { documentId: 'doc-123' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { comments: unknown[] };
    // Should filter out resolved comments by default
    expect(data.comments).toHaveLength(1);
    expect((data.comments[0] as { id: string }).id).toBe('c1');

    // Verify Drive API was called with correct fields
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/files/doc-123/comments');
    expect(url).toContain('fields=');
  });

  it('includes resolved comments when includeResolved is true', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({
        comments: [
          {
            id: 'c1',
            content: 'Fix this',
            author: { displayName: 'Zeke', emailAddress: 'zeke@example.com' },
            resolved: false,
            replies: [],
          },
          {
            id: 'c2',
            content: 'Done already',
            author: { displayName: 'Zeke', emailAddress: 'zeke@example.com' },
            resolved: true,
            replies: [],
          },
        ],
      }),
    );

    const result = await googleDocsActions.execute(
      'docs.list_comments',
      { documentId: 'doc-123', includeResolved: true },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { comments: unknown[] };
    expect(data.comments).toHaveLength(2);
  });

  it('paginates through all comments', async () => {
    mockFetch
      .mockResolvedValueOnce(
        okResponse({
          comments: [{ id: 'c1', content: 'First', author: {}, resolved: false, replies: [] }],
          nextPageToken: 'page2',
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          comments: [{ id: 'c2', content: 'Second', author: {}, resolved: false, replies: [] }],
        }),
      );

    const result = await googleDocsActions.execute(
      'docs.list_comments',
      { documentId: 'doc-123' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { comments: unknown[] };
    expect(data.comments).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles Google Docs URLs as documentId', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ comments: [] }));

    await googleDocsActions.execute(
      'docs.list_comments',
      { documentId: 'https://docs.google.com/document/d/abc123/edit' },
      makeCtx(),
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/files/abc123/comments');
  });
});

describe('docs.create_comment', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('creates an unanchored comment', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({
        id: 'c-new',
        content: 'Needs revision',
        author: { displayName: 'Agent', emailAddress: 'agent@example.com' },
      }),
    );

    const result = await googleDocsActions.execute(
      'docs.create_comment',
      { documentId: 'doc-123', content: 'Needs revision' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { id: string; content: string };
    expect(data.id).toBe('c-new');
    expect(data.content).toBe('Needs revision');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/files/doc-123/comments');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.content).toBe('Needs revision');
  });
});

describe('docs.reply_to_comment', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts a reply to a comment', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({
        id: 'r-new',
        content: 'Good point, fixing now',
        author: { displayName: 'Agent' },
      }),
    );

    const result = await googleDocsActions.execute(
      'docs.reply_to_comment',
      { documentId: 'doc-123', commentId: 'c1', content: 'Good point, fixing now' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/files/doc-123/comments/c1/replies');
    const body = JSON.parse(opts.body);
    expect(body.content).toBe('Good point, fixing now');
    expect(body.action).toBeUndefined();
  });

  it('resolves a comment when resolve is true', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({ id: 'r-new', content: 'Fixed', action: 'resolve' }),
    );

    const result = await googleDocsActions.execute(
      'docs.reply_to_comment',
      { documentId: 'doc-123', commentId: 'c1', content: 'Fixed', resolve: true },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.action).toBe('resolve');
  });

  it('reopens a comment when reopen is true', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({ id: 'r-new', content: 'Actually not fixed', action: 'reopen' }),
    );

    const result = await googleDocsActions.execute(
      'docs.reply_to_comment',
      { documentId: 'doc-123', commentId: 'c1', content: 'Actually not fixed', reopen: true },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.action).toBe('reopen');
  });
});
