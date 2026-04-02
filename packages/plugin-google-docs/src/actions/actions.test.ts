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

function makeDocumentWithTable() {
  return {
    body: {
      content: [
        {
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 7,
                textRun: { content: 'Intro\n' },
              },
            ],
          },
        },
        {
          table: {
            rows: 2,
            columns: 2,
            tableRows: [
              {
                tableCells: [
                  {
                    content: [
                      {
                        paragraph: {
                          elements: [
                            {
                              startIndex: 8,
                              endIndex: 13,
                              textRun: { content: 'Name\n' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  {
                    content: [
                      {
                        paragraph: {
                          elements: [
                            {
                              startIndex: 13,
                              endIndex: 14,
                              textRun: { content: '\n' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
              {
                tableCells: [
                  {
                    content: [
                      {
                        paragraph: {
                          elements: [
                            {
                              startIndex: 14,
                              endIndex: 19,
                              textRun: { content: 'Tier\n' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  {
                    content: [
                      {
                        paragraph: {
                          elements: [
                            {
                              startIndex: 19,
                              endIndex: 27,
                              textRun: { content: 'Current\n' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}

describe('google docs actions', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('accepts a full Google Docs URL for read_document and annotates table indexes', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(makeDocumentWithTable()));

    const result = await googleDocsActions.execute(
      'docs.read_document',
      {
        documentId: 'https://docs.google.com/document/d/doc-123/edit?tab=t.0',
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/documents/doc-123');
    expect((result.data as { markdown: string }).markdown).toContain('[Table 0]');
  });

  it('accepts operationsJson for update_document', async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(makeDocumentWithTable()))
      .mockResolvedValueOnce(okResponse());

    const result = await googleDocsActions.execute(
      'docs.update_document',
      {
        documentId: 'https://docs.google.com/document/d/doc-123/edit',
        operationsJson: [
          {
            type: 'fillCell',
            tableIndex: 0,
            row: 0,
            col: 1,
            text: 'Wallet Export v2',
          },
        ],
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toContain('/documents/doc-123');
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.requests).toEqual([
      {
        insertText: {
          location: { index: 13 },
          text: 'Wallet Export v2',
        },
      },
    ]);
  });

  it('reads a newly created document before inserting markdown content', async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse({ documentId: 'doc-123', title: 'New Doc' }))
      .mockResolvedValueOnce(okResponse({
        body: {
          content: [
            {
              paragraph: {
                elements: [
                  { startIndex: 1, endIndex: 2, textRun: { content: '\n' } },
                ],
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(okResponse());

    const result = await googleDocsActions.execute(
      'docs.create_document',
      {
        title: 'New Doc',
        markdown: 'Hello world',
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toContain('/documents');
    expect(mockFetch.mock.calls[1][0]).toContain('/documents/doc-123');
    const body = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(body.requests[0]).toEqual({
      insertText: {
        location: { index: 1 },
        text: 'Hello world',
      },
    });
  });

  describe('docs.list_sections', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('returns all sections with heading, level, and index ranges', async () => {
      const doc = {
        body: {
          content: [
            {
              paragraph: {
                paragraphStyle: { namedStyleType: 'HEADING_1' },
                elements: [
                  { startIndex: 1, endIndex: 12, textRun: { content: 'Chapter 1\n' } },
                ],
              },
            },
            {
              paragraph: {
                elements: [
                  { startIndex: 12, endIndex: 30, textRun: { content: 'Some body text.\n' } },
                ],
              },
            },
            {
              paragraph: {
                paragraphStyle: { namedStyleType: 'HEADING_2' },
                elements: [
                  { startIndex: 30, endIndex: 43, textRun: { content: 'Subsection\n' } },
                ],
              },
            },
            {
              paragraph: {
                paragraphStyle: { namedStyleType: 'HEADING_1' },
                elements: [
                  { startIndex: 43, endIndex: 54, textRun: { content: 'Chapter 2\n' } },
                ],
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce(okResponse(doc));

      const result = await googleDocsActions.execute(
        'docs.list_sections',
        { documentId: 'doc-123' },
        makeCtx(),
      );

      expect(result.success).toBe(true);
      const data = result.data as { sections: Array<{ heading: string; level: number; startIndex: number; endIndex: number }> };
      expect(data.sections).toEqual([
        { heading: 'Chapter 1', level: 1, startIndex: 1, endIndex: 43 },
        { heading: 'Subsection', level: 2, startIndex: 30, endIndex: 43 },
        { heading: 'Chapter 2', level: 1, startIndex: 43, endIndex: 54 },
      ]);
    });

    it('returns empty array for document with no headings', async () => {
      const doc = {
        body: {
          content: [
            {
              paragraph: {
                elements: [
                  { startIndex: 1, endIndex: 12, textRun: { content: 'Just text.\n' } },
                ],
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce(okResponse(doc));

      const result = await googleDocsActions.execute(
        'docs.list_sections',
        { documentId: 'doc-123' },
        makeCtx(),
      );

      expect(result.success).toBe(true);
      const data = result.data as { sections: unknown[] };
      expect(data.sections).toEqual([]);
    });
  });

  it('rejects empty fillCell text before making API calls', async () => {
    const result = await googleDocsActions.execute(
      'docs.update_document',
      {
        documentId: 'doc-123',
        operationsJson: [
          {
            type: 'fillCell',
            tableIndex: 0,
            row: 0,
            col: 1,
            text: '',
          },
        ],
      },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('at least 1 character');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
