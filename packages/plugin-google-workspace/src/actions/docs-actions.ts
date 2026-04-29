/**
 * Google Docs actions — 26 total (read/write, content insertion, tabs,
 * formatting, comments).
 *
 * Ported from the reference MCP server tools. Uses raw fetch() via
 * docs-helpers.ts and markdown conversion via docs-markdown.ts.
 * Comments use the Drive API v3 (not the Docs API).
 */

import { z } from 'zod';
import type { ActionDefinition, ActionContext, ActionResult } from '@valet/sdk';
import {
  docsFetch,
  driveFetchForDocs,
  apiError,
  normalizeDocumentId,
  executeBatchUpdate,
  executeBatchUpdateWithSplitting,
  findTextRange,
  findTabById,
  getAllTabs,
  getTabTextLength,
  getParagraphRange,
  buildUpdateTextStyleRequest,
  buildUpdateParagraphStyleRequest,
  createTable,
  insertInlineImage,
} from './docs-helpers.js';
import type { TextStyleArgs, ParagraphStyleArgs } from './docs-helpers.js';
import type { DocsRequest } from './docs-markdown.js';
import {
  docsJsonToMarkdown,
  convertMarkdownToRequests,
  insertMarkdown,
  formatInsertResult,
} from './docs-markdown.js';
import type { DocsBody, DocsLists } from './docs-markdown.js';

// ─── Action Definitions ──────────────────────────────────────────────────────

const allActions: ActionDefinition[] = [
  {
    id: 'docs.read_document',
    name: 'Read Document',
    description:
      'Read document content as text, markdown, or JSON (JSON includes character indices for surgical editing)',
    riskLevel: 'low',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      format: z
        .enum(['text', 'json', 'markdown'])
        .optional()
        .default('text'),
      maxLength: z
        .number()
        .optional()
        .describe('Maximum character limit for output'),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.insert_text',
    name: 'Insert Text',
    description: 'Insert text at a specific 1-based character index',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string(),
      text: z.string().min(1),
      index: z.number().int().min(1),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.append_text',
    name: 'Append Text',
    description: 'Append plain text to the end of a document',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string(),
      text: z.string().min(1),
      addNewlineIfNeeded: z.boolean().optional().default(true),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.modify_text',
    name: 'Modify Text',
    description:
      'Replace, insert, or format text in one atomic operation. Target by character range, text search, or insertion index.',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string(),
      target: z.union([
        z.object({
          startIndex: z.number().int().min(1),
          endIndex: z.number().int().min(1),
        }),
        z.object({
          textToFind: z.string().min(1),
          matchInstance: z.number().int().min(1).optional(),
        }),
        z.object({
          insertionIndex: z.number().int().min(1),
        }),
      ]),
      text: z.string().optional(),
      style: z
        .object({
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          underline: z.boolean().optional(),
          strikethrough: z.boolean().optional(),
          fontSize: z.number().optional(),
          fontFamily: z.string().optional(),
          foregroundColor: z.string().optional(),
          backgroundColor: z.string().optional(),
          linkUrl: z.string().optional(),
        })
        .optional(),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.delete_range',
    name: 'Delete Range',
    description: 'Delete content within a character range [startIndex, endIndex)',
    riskLevel: 'high',
    params: z.object({
      documentId: z.string(),
      startIndex: z.number().int().min(1),
      endIndex: z.number().int().min(1),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.find_and_replace',
    name: 'Find and Replace',
    description:
      'Replace all occurrences of a text string throughout the document',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string(),
      findText: z.string().min(1),
      replaceText: z.string(),
      matchCase: z.boolean().optional(),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.append_markdown',
    name: 'Append Markdown',
    description: 'Append formatted markdown content to the end of a document',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string(),
      markdown: z.string().min(1),
      addNewlineIfNeeded: z.boolean().optional().default(true),
      tabId: z.string().optional(),
      firstHeadingAsTitle: z.boolean().optional(),
    }),
  },
  {
    id: 'docs.replace_document_with_markdown',
    name: 'Replace Document with Markdown',
    description:
      'Replace the entire document body with formatted markdown content',
    riskLevel: 'high',
    params: z.object({
      documentId: z.string(),
      markdown: z.string().min(1),
      preserveTitle: z.boolean().optional(),
      tabId: z.string().optional(),
      firstHeadingAsTitle: z.boolean().optional(),
    }),
  },

  // ── Content Insertion ──────────────────────────────────────────────────────

  {
    id: 'docs.insert_table',
    name: 'Insert Table',
    description:
      'Insert an empty table with the specified number of rows and columns at a character index',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      rows: z.number().int().min(1).describe('Number of rows'),
      columns: z.number().int().min(1).describe('Number of columns'),
      index: z.number().int().min(1).describe('1-based character index'),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.insert_table_with_data',
    name: 'Insert Table with Data',
    description:
      'Insert a table pre-populated with data. Optionally bolds the first row as a header. Ragged rows are padded with empty cells.',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      data: z
        .array(z.array(z.string()).max(50))
        .min(1)
        .max(200)
        .describe('2D array of strings — each inner array is one row'),
      index: z.number().int().min(1).describe('1-based character index'),
      hasHeaderRow: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, bold the first row as a header'),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.insert_image',
    name: 'Insert Image',
    description:
      'Insert an inline image from a publicly accessible URL at a character index',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      imageUrl: z.string().url().describe('Publicly accessible image URL'),
      index: z.number().int().min(1).describe('1-based character index'),
      width: z.number().min(1).optional().describe('Width in points'),
      height: z.number().min(1).optional().describe('Height in points'),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.insert_page_break',
    name: 'Insert Page Break',
    description: 'Insert a page break at a character index',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      index: z.number().int().min(1).describe('1-based character index'),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.insert_section_break',
    name: 'Insert Section Break',
    description:
      'Insert a section break. Use NEXT_PAGE when you need a fresh page (e.g. mixing portrait/landscape). Use CONTINUOUS for inline section changes.',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      index: z.number().int().min(1).describe('1-based character index'),
      sectionType: z
        .enum(['NEXT_PAGE', 'CONTINUOUS'])
        .optional()
        .default('NEXT_PAGE')
        .describe('Section break type'),
      tabId: z.string().optional(),
    }),
  },

  // ── Tabs ───────────────────────────────────────────────────────────────────

  {
    id: 'docs.add_tab',
    name: 'Add Tab',
    description:
      'Add a new tab to a document. Optionally set title, position, and parent tab for nesting.',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      title: z.string().optional().describe('Title for the new tab'),
      parentTabId: z
        .string()
        .optional()
        .describe('ID of existing tab to nest under as a child'),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Zero-based position among sibling tabs'),
    }),
  },
  {
    id: 'docs.list_tabs',
    name: 'List Tabs',
    description:
      'List all tabs in a document with IDs, titles, and hierarchy. Use tab IDs with other tools.',
    riskLevel: 'low',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      includeContent: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include character count per tab'),
    }),
  },
  {
    id: 'docs.rename_tab',
    name: 'Rename Tab',
    description: 'Rename a tab in a document',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      tabId: z.string().describe('ID of the tab to rename'),
      newTitle: z.string().min(1).describe('New title for the tab'),
    }),
  },

  // ── Formatting ─────────────────────────────────────────────────────────────

  {
    id: 'docs.apply_text_style',
    name: 'Apply Text Style',
    description:
      'Apply character-level formatting (bold, italic, color, font, etc.) to text identified by range or text search',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      target: z.union([
        z.object({
          startIndex: z.number().int().min(1),
          endIndex: z.number().int().min(1),
        }),
        z.object({
          textToFind: z.string().min(1),
          matchInstance: z.number().int().min(1).optional()
            .describe('Which occurrence to match (default: 1). Ignored when allOccurrences is true.'),
          allOccurrences: z.boolean().optional()
            .describe('Apply style to ALL occurrences of textToFind (default: false)'),
        }),
      ]),
      style: z.object({
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        underline: z.boolean().optional(),
        strikethrough: z.boolean().optional(),
        fontSize: z.number().optional(),
        fontFamily: z.string().optional(),
        foregroundColor: z.string().optional(),
        backgroundColor: z.string().optional(),
        linkUrl: z.string().optional(),
      }),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.apply_paragraph_style',
    name: 'Apply Paragraph Style',
    description:
      'Apply paragraph-level formatting (alignment, spacing, heading styles) to paragraphs identified by range, text search, or index',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      target: z.union([
        z.object({
          startIndex: z.number().int().min(1),
          endIndex: z.number().int().min(1),
        }),
        z.object({
          textToFind: z.string().min(1),
          matchInstance: z.number().int().min(1).optional(),
        }),
        z.object({
          indexWithinParagraph: z.number().int().min(1),
        }),
      ]),
      style: z.object({
        alignment: z.enum(['START', 'END', 'CENTER', 'JUSTIFIED']).optional(),
        indentStart: z.number().optional(),
        indentEnd: z.number().optional(),
        spaceAbove: z.number().optional(),
        spaceBelow: z.number().optional(),
        namedStyleType: z
          .enum([
            'NORMAL_TEXT',
            'TITLE',
            'SUBTITLE',
            'HEADING_1',
            'HEADING_2',
            'HEADING_3',
            'HEADING_4',
            'HEADING_5',
            'HEADING_6',
          ])
          .optional(),
        keepWithNext: z.boolean().optional(),
      }),
      tabId: z.string().optional(),
    }),
  },
  {
    id: 'docs.update_section_style',
    name: 'Update Section Style',
    description:
      'Update the style of a section identified by range — supports page orientation, margins, and section type',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      startIndex: z.number().int().min(1),
      endIndex: z.number().int().min(1),
      flipPageOrientation: z.boolean().optional(),
      sectionType: z
        .enum(['SECTION_TYPE_UNSPECIFIED', 'CONTINUOUS', 'NEXT_PAGE'])
        .optional(),
      marginTop: z.number().nonnegative().optional().describe('Points'),
      marginBottom: z.number().nonnegative().optional().describe('Points'),
      marginLeft: z.number().nonnegative().optional().describe('Points'),
      marginRight: z.number().nonnegative().optional().describe('Points'),
      pageNumberStart: z.number().int().min(1).optional(),
      tabId: z.string().optional(),
    }),
  },

  // ── Comments (Drive API v3) ────────────────────────────────────────────────

  {
    id: 'docs.list_comments',
    name: 'List Comments',
    description:
      'List all comments in a document with IDs, authors, status, and quoted text',
    riskLevel: 'low',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
    }),
  },
  {
    id: 'docs.get_comment',
    name: 'Get Comment',
    description:
      'Get a specific comment and its full reply thread',
    riskLevel: 'low',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      commentId: z.string().describe('Comment ID'),
    }),
  },
  {
    id: 'docs.add_comment',
    name: 'Add Comment',
    description:
      'Add a comment anchored to a text range in the document',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      startIndex: z.number().int().min(1).describe('Start of text range (inclusive, 1-based)'),
      endIndex: z.number().int().min(1).describe('End of text range (exclusive)'),
      content: z.string().min(1).describe('Comment text'),
    }),
  },
  {
    id: 'docs.reply_to_comment',
    name: 'Reply to Comment',
    description: 'Add a reply to an existing comment thread',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      commentId: z.string().describe('Comment ID to reply to'),
      content: z.string().min(1).describe('Reply text'),
    }),
  },
  {
    id: 'docs.delete_comment',
    name: 'Delete Comment',
    description: 'Permanently delete a comment and all its replies',
    riskLevel: 'high',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      commentId: z.string().describe('Comment ID to delete'),
    }),
  },
  {
    id: 'docs.resolve_comment',
    name: 'Resolve Comment',
    description: 'Mark a comment as resolved',
    riskLevel: 'medium',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      commentId: z.string().describe('Comment ID to resolve'),
    }),
  },
  {
    id: 'docs.find_text_index',
    name: 'Find Text Index',
    description:
      'Find the character index of a text string in a document. Returns { startIndex, endIndex } for use with insert_text, modify_text, delete_range, and other index-based tools. Much lighter than reading the full document with format=json.',
    riskLevel: 'low',
    params: z.object({
      documentId: z.string().describe('Document ID or full Google Docs URL'),
      textToFind: z.string().min(1).describe('The text to search for in the document'),
      matchInstance: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Which occurrence to match (default: 1, i.e. first match)'),
      tabId: z.string().optional(),
    }),
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Raw doc JSON from API
type DocJson = Record<string, any>;

/** Fetch a full document and return the parsed JSON. */
async function fetchDocument(
  token: string,
  documentId: string,
  options?: { includeTabsContent?: boolean; fields?: string },
): Promise<{ ok: true; doc: DocJson } | { ok: false; result: ActionResult }> {
  const qs = new URLSearchParams();
  if (options?.fields) qs.set('fields', options.fields);
  if (options?.includeTabsContent) qs.set('includeTabsContent', 'true');

  const qsStr = qs.toString();
  const path = `/documents/${encodeURIComponent(documentId)}${qsStr ? `?${qsStr}` : ''}`;
  const res = await docsFetch(path, token);
  if (!res.ok) {
    return { ok: false, result: await apiError(res, 'Docs') };
  }
  return { ok: true, doc: (await res.json()) as DocJson };
}

/** Get the body content from a doc response, optionally from a specific tab. */
function getBodyContent(
  doc: DocJson,
  tabId?: string,
): { body: unknown[]; lists?: DocsLists } | { error: string } {
  if (tabId) {
    const tab = findTabById(doc, tabId);
    if (!tab) return { error: `Tab with ID "${tabId}" not found in document.` };
    const dt = (tab as DocJson).documentTab as
      | { body?: { content?: unknown[] }; lists?: DocsLists }
      | undefined;
    if (!dt?.body?.content) {
      return { error: `Tab "${tabId}" does not have content.` };
    }
    return { body: dt.body.content, lists: dt.lists };
  }
  const body = (doc.body as { content?: unknown[] })?.content;
  if (!body) return { error: 'Document has no body content.' };
  return { body, lists: doc.lists as DocsLists | undefined };
}

/** Get the end index (last element's endIndex) from body content. */
function getEndIndex(bodyContent: unknown[]): number {
  if (bodyContent.length === 0) return 1;
  const lastElement = bodyContent[bodyContent.length - 1] as { endIndex?: number };
  return lastElement.endIndex ?? 1;
}

/** Extract plain text from body content elements. */
function extractPlainText(bodyContent: unknown[]): string {
  let text = '';
  for (const element of bodyContent as Record<string, unknown>[]) {
    const para = element.paragraph as { elements?: Record<string, unknown>[] } | undefined;
    if (para?.elements) {
      for (const pe of para.elements) {
        const textRun = pe.textRun as { content?: string } | undefined;
        if (textRun?.content) {
          text += textRun.content;
        }
      }
    }
    const table = element.table as { tableRows?: Record<string, unknown>[] } | undefined;
    if (table?.tableRows) {
      for (const row of table.tableRows) {
        const cells = (row as { tableCells?: Record<string, unknown>[] }).tableCells;
        if (cells) {
          for (const cell of cells) {
            const content = (cell as { content?: unknown[] }).content;
            if (content) {
              text += extractPlainText(content);
            }
          }
        }
      }
    }
  }
  return text;
}

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = ctx.credentials.access_token || '';
  if (!token) return { success: false, error: 'Missing access token' };

  try {
    switch (actionId) {
      // ── docs.read_document ──────────────────────────────────────────
      case 'docs.read_document': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          format: 'text' | 'json' | 'markdown';
          maxLength?: number;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);
        const needsTabsContent = !!p.tabId;

        // Determine fields to fetch
        const fields =
          p.format === 'json' || p.format === 'markdown'
            ? '*'
            : 'body(content(paragraph(elements(textRun(content)))))';

        const fetchResult = await fetchDocument(token, docId, {
          includeTabsContent: needsTabsContent,
          fields: needsTabsContent ? '*' : fields,
        });
        if (!fetchResult.ok) return fetchResult.result;
        const doc = fetchResult.doc;

        // Resolve content source (tab or root body)
        let contentSource: DocJson;
        if (p.tabId) {
          const tab = findTabById(doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
          const dt = (tab as DocJson).documentTab;
          if (!dt) {
            return {
              success: false,
              error: `Tab "${p.tabId}" does not have content (may not be a document tab).`,
            };
          }
          contentSource = { body: dt.body, lists: dt.lists };
        } else {
          contentSource = doc;
        }

        // JSON format
        if (p.format === 'json') {
          // Strip top-level metadata and empty objects to reduce output size.
          // documentStyle, namedStyles, revisionId, suggestedNamedStylesChanges,
          // etc. add significant bulk but aren't useful for editing operations.
          const slimSource = { ...contentSource as Record<string, unknown> };
          delete slimSource.documentStyle;
          delete slimSource.namedStyles;
          delete slimSource.revisionId;
          delete slimSource.documentId;
          delete slimSource.suggestedDocumentStyleChanges;
          delete slimSource.suggestedNamedStylesChanges;
          // Keep inlineObjects and positionedObjects -- paragraph elements
          // reference these by ID for inline/anchored images.
          delete slimSource.headers;
          delete slimSource.footers;
          delete slimSource.footnotes;

          const jsonContent = JSON.stringify(slimSource, (_key, value) => {
            // Prune empty objects (e.g. textStyle: {}, paragraphStyle: {})
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              if (Object.keys(value).length === 0) return undefined;
            }
            return value;
          }, 2);
          if (p.maxLength && jsonContent.length > p.maxLength) {
            return {
              success: true,
              data: {
                content:
                  jsonContent.substring(0, p.maxLength) +
                  `\n... [JSON truncated: ${jsonContent.length} total chars]`,
              },
            };
          }
          return { success: true, data: { content: jsonContent } };
        }

        // Markdown format
        if (p.format === 'markdown') {
          const body = (contentSource.body ?? {}) as DocsBody;
          const lists = contentSource.lists as DocsLists | undefined;
          const markdownContent = docsJsonToMarkdown(body, lists);
          const totalLength = markdownContent.length;

          if (p.maxLength && totalLength > p.maxLength) {
            return {
              success: true,
              data: {
                content:
                  markdownContent.substring(0, p.maxLength) +
                  `\n\n... [Markdown truncated to ${p.maxLength} chars of ${totalLength} total.]`,
              },
            };
          }
          return { success: true, data: { content: markdownContent } };
        }

        // Text format (default)
        const bodyContent = (contentSource.body as { content?: unknown[] })?.content;
        if (!bodyContent) {
          return { success: true, data: { content: 'Document found, but appears empty.' } };
        }

        const textContent = extractPlainText(bodyContent);
        if (!textContent.trim()) {
          return { success: true, data: { content: 'Document found, but appears empty.' } };
        }

        const totalLength = textContent.length;
        if (p.maxLength && totalLength > p.maxLength) {
          return {
            success: true,
            data: {
              content:
                `Content (truncated to ${p.maxLength} chars of ${totalLength} total):\n---\n` +
                textContent.substring(0, p.maxLength) +
                `\n\n... [Document continues for ${totalLength - p.maxLength} more characters.]`,
            },
          };
        }

        return {
          success: true,
          data: { content: `Content (${totalLength} characters):\n---\n${textContent}` },
        };
      }

      // ── docs.insert_text ────────────────────────────────────────────
      case 'docs.insert_text': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          text: string;
          index: number;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        // Verify tab exists if specified
        if (p.tabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const tab = findTabById(tabCheck.doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
        }

        const location: Record<string, unknown> = { index: p.index };
        if (p.tabId) location.tabId = p.tabId;

        const request: DocsRequest = {
          insertText: { location, text: p.text },
        };

        const batchResult = await executeBatchUpdate(docId, token, [request]);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to insert text' };
        }

        return {
          success: true,
          data: {
            message: `Successfully inserted text at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.append_text ────────────────────────────────────────────
      case 'docs.append_text': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          text: string;
          addNewlineIfNeeded: boolean;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        // Get the current document body
        const fetchResult = await fetchDocument(token, docId, {
          includeTabsContent: !!p.tabId,
          fields: p.tabId ? 'tabs' : 'body(content(endIndex))',
        });
        if (!fetchResult.ok) return fetchResult.result;

        const bodyResult = getBodyContent(fetchResult.doc, p.tabId);
        if ('error' in bodyResult) return { success: false, error: bodyResult.error };

        let endIndex = getEndIndex(bodyResult.body);
        // Insert before the final newline
        endIndex = Math.max(1, endIndex - 1);

        const textToInsert = (p.addNewlineIfNeeded && endIndex > 1 ? '\n' : '') + p.text;
        if (!textToInsert) {
          return { success: true, data: { message: 'Nothing to append.' } };
        }

        const location: Record<string, unknown> = { index: endIndex };
        if (p.tabId) location.tabId = p.tabId;

        const request: DocsRequest = {
          insertText: { location, text: textToInsert },
        };
        const batchResult = await executeBatchUpdate(docId, token, [request]);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to append text' };
        }

        return {
          success: true,
          data: {
            message: `Successfully appended text to ${p.tabId ? `tab ${p.tabId} in ` : ''}document.`,
          },
        };
      }

      // ── docs.modify_text ────────────────────────────────────────────
      case 'docs.modify_text': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          target:
            | { startIndex: number; endIndex: number }
            | { textToFind: string; matchInstance?: number }
            | { insertionIndex: number };
          text?: string;
          style?: {
            bold?: boolean;
            italic?: boolean;
            underline?: boolean;
            strikethrough?: boolean;
            fontSize?: number;
            fontFamily?: string;
            foregroundColor?: string;
            backgroundColor?: string;
            linkUrl?: string;
          };
          tabId?: string;
        };

        if (p.text === undefined && p.style === undefined) {
          return { success: false, error: 'At least one of text or style must be provided.' };
        }

        const docId = normalizeDocumentId(p.documentId);

        // Verify tab exists if specified
        if (p.tabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const tab = findTabById(tabCheck.doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
        }

        // Resolve target to numeric indices
        let startIndex: number;
        let endIndex: number | undefined;

        if ('insertionIndex' in p.target) {
          if (p.text === undefined) {
            return {
              success: false,
              error: 'text is required when using insertionIndex target (no existing range to format).',
            };
          }
          startIndex = p.target.insertionIndex;
          endIndex = undefined;
        } else if ('textToFind' in p.target) {
          const range = await findTextRange(
            token,
            docId,
            p.target.textToFind,
            p.target.matchInstance ?? 1,
            p.tabId,
          );
          if (!range) {
            return {
              success: false,
              error: `Could not find instance ${p.target.matchInstance ?? 1} of text "${p.target.textToFind}"${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
            };
          }
          startIndex = range.startIndex;
          endIndex = range.endIndex;
        } else {
          startIndex = p.target.startIndex;
          endIndex = p.target.endIndex;
        }

        if (startIndex < 1) startIndex = 1;

        // Build requests
        const requests: DocsRequest[] = [];

        // 1. Delete existing content (only when replacing, not insert-only)
        if (endIndex !== undefined && p.text !== undefined) {
          const range: Record<string, unknown> = { startIndex, endIndex };
          if (p.tabId) range.tabId = p.tabId;
          requests.push({ deleteContentRange: { range } });
        }

        // 2. Insert new text
        if (p.text !== undefined) {
          const location: Record<string, unknown> = { index: startIndex };
          if (p.tabId) location.tabId = p.tabId;
          requests.push({ insertText: { location, text: p.text } });
        }

        // 3. Apply formatting
        if (p.style) {
          const formatStart = startIndex;
          const formatEnd =
            p.text !== undefined
              ? startIndex + p.text.length
              : endIndex !== undefined
                ? endIndex
                : startIndex;

          if (formatEnd > formatStart) {
            const requestInfo = buildUpdateTextStyleRequest(
              formatStart,
              formatEnd,
              p.style,
              p.tabId,
            );
            if (requestInfo) {
              requests.push(requestInfo.request);
            }
          }
        }

        if (requests.length === 0) {
          return { success: true, data: { message: 'No operations to perform.' } };
        }

        const batchResult = await executeBatchUpdate(docId, token, requests, {
          preserveOrder: true,
        });
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to modify text' };
        }

        const actions: string[] = [];
        if (endIndex !== undefined && p.text !== undefined) actions.push('replaced text');
        else if (p.text !== undefined) actions.push('inserted text');
        if (p.style) actions.push('applied formatting');

        return {
          success: true,
          data: {
            message: `Successfully ${actions.join(' and ')} at range ${startIndex}-${endIndex ?? startIndex + (p.text?.length ?? 0)}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.delete_range ───────────────────────────────────────────
      case 'docs.delete_range': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          startIndex: number;
          endIndex: number;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        if (p.endIndex <= p.startIndex) {
          return { success: false, error: 'endIndex must be greater than startIndex for deletion.' };
        }

        // Verify tab exists if specified
        if (p.tabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const tab = findTabById(tabCheck.doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
        }

        const range: Record<string, unknown> = {
          startIndex: p.startIndex,
          endIndex: p.endIndex,
        };
        if (p.tabId) range.tabId = p.tabId;

        const request: DocsRequest = { deleteContentRange: { range } };
        const batchResult = await executeBatchUpdate(docId, token, [request]);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to delete range' };
        }

        return {
          success: true,
          data: {
            message: `Successfully deleted content in range ${p.startIndex}-${p.endIndex}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.find_and_replace ───────────────────────────────────────
      case 'docs.find_and_replace': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          findText: string;
          replaceText: string;
          matchCase?: boolean;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        const request: DocsRequest = {
          replaceAllText: {
            containsText: {
              text: p.findText,
              matchCase: p.matchCase ?? false,
            },
            replaceText: p.replaceText,
            ...(p.tabId && { tabsCriteria: { tabIds: [p.tabId] } }),
          },
        };

        const batchResult = await executeBatchUpdate(docId, token, [request]);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to find and replace' };
        }

        // Extract occurrencesChanged from the API response
        const responseData = batchResult.data as {
          replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }>;
        } | undefined;
        const occurrencesChanged = responseData?.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;

        return {
          success: true,
          data: {
            message: `Replaced ${occurrencesChanged} occurrence(s) of "${p.findText}" with "${p.replaceText}".`,
            occurrencesChanged,
          },
        };
      }

      // ── docs.append_markdown ────────────────────────────────────────
      case 'docs.append_markdown': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          markdown: string;
          addNewlineIfNeeded: boolean;
          tabId?: string;
          firstHeadingAsTitle?: boolean;
        };
        const docId = normalizeDocumentId(p.documentId);

        // 1. Get document end index
        const fetchResult = await fetchDocument(token, docId, {
          includeTabsContent: !!p.tabId,
          fields: p.tabId ? 'tabs' : 'body(content(endIndex))',
        });
        if (!fetchResult.ok) return fetchResult.result;

        const bodyResult = getBodyContent(fetchResult.doc, p.tabId);
        if ('error' in bodyResult) return { success: false, error: bodyResult.error };

        let startIndex = getEndIndex(bodyResult.body) - 1;

        // 2. Add spacing if needed
        if (p.addNewlineIfNeeded && startIndex > 1) {
          const location: Record<string, unknown> = { index: startIndex };
          if (p.tabId) location.tabId = p.tabId;

          const spacingResult = await executeBatchUpdate(docId, token, [
            { insertText: { location, text: '\n\n' } },
          ]);
          if (!spacingResult.success) {
            return { success: false, error: spacingResult.error || 'Failed to add spacing' };
          }
          startIndex += 2;
        }

        // 3. Convert and append markdown
        const result = await insertMarkdown(token, docId, p.markdown, {
          startIndex,
          tabId: p.tabId,
          firstHeadingAsTitle: p.firstHeadingAsTitle,
        });

        const debugSummary = formatInsertResult(result);
        return {
          success: true,
          data: {
            message: `Successfully appended ${p.markdown.length} characters of markdown.\n\n${debugSummary}`,
          },
        };
      }

      // ── docs.replace_document_with_markdown ─────────────────────────
      case 'docs.replace_document_with_markdown': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          markdown: string;
          preserveTitle?: boolean;
          tabId?: string;
          firstHeadingAsTitle?: boolean;
        };
        const docId = normalizeDocumentId(p.documentId);

        // 1. Get document structure
        const fetchResult = await fetchDocument(token, docId, {
          includeTabsContent: !!p.tabId,
          fields: p.tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
        });
        if (!fetchResult.ok) return fetchResult.result;

        const bodyResult = getBodyContent(fetchResult.doc, p.tabId);
        if ('error' in bodyResult) return { success: false, error: bodyResult.error };

        // 2. Calculate replacement range
        let startIndex = 1;
        let endIndex = getEndIndex(bodyResult.body) - 1;

        if (p.preserveTitle) {
          // Find first content element that's a heading or paragraph, skip past it
          for (const element of bodyResult.body as Record<string, unknown>[]) {
            const elemEnd = (element as { endIndex?: number }).endIndex;
            if ((element as { paragraph?: unknown }).paragraph && elemEnd) {
              startIndex = elemEnd;
              break;
            }
          }
        }

        // 3. Delete existing content
        if (endIndex > startIndex) {
          const deleteRange: Record<string, unknown> = { startIndex, endIndex };
          if (p.tabId) deleteRange.tabId = p.tabId;

          const deleteResult = await executeBatchUpdate(docId, token, [
            { deleteContentRange: { range: deleteRange } },
          ]);
          if (!deleteResult.success) {
            return { success: false, error: deleteResult.error || 'Failed to delete existing content' };
          }
        }

        // 4. Clean the surviving trailing paragraph
        //    deleteContentRange always leaves one trailing paragraph that cannot
        //    be deleted. If it has bullet list membership or text formatting from
        //    the old content, all subsequently inserted text inherits those
        //    properties. We strip both bullets and text styles from the survivor.
        {
          const afterDeleteResult = await fetchDocument(token, docId, {
            includeTabsContent: !!p.tabId,
            fields: p.tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
          });
          if (!afterDeleteResult.ok) {
            // Non-fatal: proceed with insert anyway
          } else {
            const afterBody = getBodyContent(afterDeleteResult.doc, p.tabId);
            if (!('error' in afterBody)) {
              const survivorEnd = getEndIndex(afterBody.body);
              const survivorRange: Record<string, unknown> = {
                startIndex,
                endIndex: survivorEnd,
              };
              if (p.tabId) survivorRange.tabId = p.tabId;

              const cleanupRequests: DocsRequest[] = [
                { deleteParagraphBullets: { range: survivorRange } },
                {
                  updateTextStyle: {
                    range: survivorRange,
                    textStyle: {
                      underline: false,
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      // Explicit black — an empty foregroundColor ({}) means
                      // "no direct formatting" which the Docs renderer treats
                      // as "continue the previous run's color," causing
                      // inserted text to inherit stale colors from the old doc.
                      foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
                      backgroundColor: {},
                    },
                    fields:
                      'underline,bold,italic,strikethrough,foregroundColor,backgroundColor,link,weightedFontFamily,fontSize',
                  },
                },
              ];

              // Non-fatal cleanup
              try {
                await executeBatchUpdate(docId, token, cleanupRequests, {
                  preserveOrder: true,
                });
              } catch {
                // Cleanup is best-effort
              }
            }
          }
        }

        // 5. Convert markdown and insert
        const result = await insertMarkdown(token, docId, p.markdown, {
          startIndex,
          tabId: p.tabId,
          firstHeadingAsTitle: p.firstHeadingAsTitle,
        });

        const debugSummary = formatInsertResult(result);
        return {
          success: true,
          data: {
            message: `Successfully replaced document content with ${p.markdown.length} characters of markdown.\n\n${debugSummary}`,
          },
        };
      }

      // ── docs.insert_table ──────────────────────────────────────────
      case 'docs.insert_table': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          rows: number;
          columns: number;
          index: number;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        if (p.tabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const tab = findTabById(tabCheck.doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
        }

        const result = await createTable(token, docId, p.rows, p.columns, p.index, p.tabId);
        if (!result.success) {
          return { success: false, error: result.error || 'Failed to insert table' };
        }

        return {
          success: true,
          data: {
            message: `Successfully inserted a ${p.rows}x${p.columns} table at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.insert_table_with_data ────────────────────────────────
      case 'docs.insert_table_with_data': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          data: string[][];
          index: number;
          hasHeaderRow: boolean;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        const numRows = p.data.length;
        const numCols = p.data.reduce((max, row) => Math.max(max, row.length), 0);

        if (numRows === 0 || numCols === 0) {
          return { success: false, error: 'Table data must contain at least one non-empty row with at least one cell.' };
        }

        if (p.tabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const tab = findTabById(tabCheck.doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
        }

        // Pad ragged rows
        const normalizedData = p.data.map((row) => {
          const padded = [...row];
          while (padded.length < numCols) padded.push('');
          return padded;
        });

        // Build requests: insert table + populate cells + optional header bold
        const requests: DocsRequest[] = [];
        const formatRequests: DocsRequest[] = [];

        const location: Record<string, unknown> = { index: p.index };
        if (p.tabId) location.tabId = p.tabId;
        requests.push({ insertTable: { location, rows: numRows, columns: numCols } });

        // Cell index math: cellContentIndex(T, r, c, C) = T + 4 + r * (1 + 2*C) + 2*c
        let cumulativeTextLength = 0;
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            const cellText = normalizedData[r][c];
            if (!cellText) continue;

            const baseCellIndex = p.index + 4 + r * (1 + 2 * numCols) + 2 * c;
            const adjustedIndex = baseCellIndex + cumulativeTextLength;

            const cellLocation: Record<string, unknown> = { index: adjustedIndex };
            if (p.tabId) cellLocation.tabId = p.tabId;

            requests.push({ insertText: { location: cellLocation, text: cellText } });

            if (p.hasHeaderRow && r === 0) {
              const styleReq = buildUpdateTextStyleRequest(
                adjustedIndex,
                adjustedIndex + cellText.length,
                { bold: true },
                p.tabId,
              );
              if (styleReq) formatRequests.push(styleReq.request);
            }

            cumulativeTextLength += cellText.length;
          }
        }

        const allRequests = [...requests, ...formatRequests];
        const meta = await executeBatchUpdateWithSplitting(token, docId, allRequests);

        return {
          success: true,
          data: {
            message: `Successfully inserted a ${numRows}x${numCols} table with data at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}. ${p.hasHeaderRow ? 'Header row bolded. ' : ''}(${meta.totalRequests} requests in ${meta.totalApiCalls} API calls, ${meta.totalElapsedMs}ms)`,
          },
        };
      }

      // ── docs.insert_image ──────────────────────────────────────────
      case 'docs.insert_image': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          imageUrl: string;
          index: number;
          width?: number;
          height?: number;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        if (p.tabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const tab = findTabById(tabCheck.doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
        }

        const result = await insertInlineImage(
          token,
          docId,
          p.imageUrl,
          p.index,
          p.width,
          p.height,
          p.tabId,
        );
        if (!result.success) {
          return { success: false, error: result.error || 'Failed to insert image' };
        }

        let sizeInfo = '';
        if (p.width && p.height) sizeInfo = ` with size ${p.width}x${p.height}pt`;

        return {
          success: true,
          data: {
            message: `Successfully inserted image at index ${p.index}${sizeInfo}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.insert_page_break ─────────────────────────────────────
      case 'docs.insert_page_break': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          index: number;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        if (p.tabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const tab = findTabById(tabCheck.doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
        }

        const loc: Record<string, unknown> = { index: p.index };
        if (p.tabId) loc.tabId = p.tabId;

        const batchResult = await executeBatchUpdate(docId, token, [
          { insertPageBreak: { location: loc } },
        ]);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to insert page break' };
        }

        return {
          success: true,
          data: {
            message: `Successfully inserted page break at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.insert_section_break ──────────────────────────────────
      case 'docs.insert_section_break': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          index: number;
          sectionType: 'NEXT_PAGE' | 'CONTINUOUS';
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        if (p.tabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const tab = findTabById(tabCheck.doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
        }

        const loc: Record<string, unknown> = { index: p.index };
        if (p.tabId) loc.tabId = p.tabId;

        const batchResult = await executeBatchUpdate(docId, token, [
          { insertSectionBreak: { location: loc, sectionType: p.sectionType } },
        ]);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to insert section break' };
        }

        return {
          success: true,
          data: {
            message: `Successfully inserted ${p.sectionType} section break at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.add_tab ───────────────────────────────────────────────
      case 'docs.add_tab': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          title?: string;
          parentTabId?: string;
          index?: number;
        };
        const docId = normalizeDocumentId(p.documentId);

        // Verify parent tab exists if specified
        if (p.parentTabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const parentTab = findTabById(tabCheck.doc, p.parentTabId);
          if (!parentTab) {
            return { success: false, error: `Parent tab with ID "${p.parentTabId}" not found in document.` };
          }
        }

        const tabProperties: Record<string, unknown> = {};
        if (p.title !== undefined) tabProperties.title = p.title;
        if (p.parentTabId !== undefined) tabProperties.parentTabId = p.parentTabId;
        if (p.index !== undefined) tabProperties.index = p.index;

        const res = await docsFetch(
          `/documents/${encodeURIComponent(docId)}:batchUpdate`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({
              requests: [{ addDocumentTab: { tabProperties } }],
            }),
          },
        );
        if (!res.ok) return await apiError(res, 'Docs batchUpdate');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resBody = (await res.json()) as any;
        const newTabProps = resBody?.replies?.[0]?.addDocumentTab?.tabProperties;

        if (newTabProps) {
          return {
            success: true,
            data: {
              message: `Successfully added new tab "${newTabProps.title || '(untitled)'}".`,
              tabId: newTabProps.tabId,
              title: newTabProps.title,
              index: newTabProps.index,
              parentTabId: newTabProps.parentTabId,
            },
          };
        }

        return { success: true, data: { message: 'Tab created but could not retrieve details.' } };
      }

      // ── docs.list_tabs ─────────────────────────────────────────────
      case 'docs.list_tabs': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          includeContent: boolean;
        };
        const docId = normalizeDocumentId(p.documentId);

        const fields = p.includeContent
          ? 'title,tabs'
          : 'title,tabs(tabProperties,childTabs)';
        const fetchResult = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields,
        });
        if (!fetchResult.ok) return fetchResult.result;

        const docTitle = (fetchResult.doc.title as string) || 'Untitled Document';
        const allTabsList = getAllTabs(fetchResult.doc);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tabs = allTabsList.map((tab) => {
          const tp = tab.tabProperties || {};
          const tabObj: Record<string, unknown> = {
            id: tp.tabId || null,
            title: tp.title || null,
            index: tp.index ?? null,
          };
          if (tp.parentTabId) tabObj.parentTabId = tp.parentTabId;
          if (p.includeContent && tab.documentTab) {
            tabObj.characterCount = getTabTextLength(tab.documentTab);
          }
          return tabObj;
        });

        return { success: true, data: { documentTitle: docTitle, tabs } };
      }

      // ── docs.rename_tab ────────────────────────────────────────────
      case 'docs.rename_tab': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          tabId: string;
          newTitle: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        // Verify tab exists and get old title — include childTabs for nested tab lookup
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,childTabs(tabProperties,childTabs(tabProperties,childTabs(tabProperties))))',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const targetTab = findTabById(tabCheck.doc, p.tabId);
        if (!targetTab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
        const oldTitle =
          (targetTab as DocJson).tabProperties?.title || '(untitled)';

        const batchResult = await executeBatchUpdate(docId, token, [
          {
            updateDocumentTabProperties: {
              tabProperties: { tabId: p.tabId, title: p.newTitle },
              fields: 'title',
            },
          },
        ]);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to rename tab' };
        }

        return {
          success: true,
          data: {
            message: `Successfully renamed tab from "${oldTitle}" to "${p.newTitle}".`,
          },
        };
      }

      // ── docs.apply_text_style ──────────────────────────────────────
      case 'docs.apply_text_style': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          target:
            | { startIndex: number; endIndex: number }
            | { textToFind: string; matchInstance?: number; allOccurrences?: boolean };
          style: TextStyleArgs;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        // Collect all ranges to style
        const ranges: Array<{ startIndex: number; endIndex: number }> = [];

        if ('textToFind' in p.target) {
          if (p.target.allOccurrences) {
            // Find ALL occurrences and batch-style them
            let instance = 1;
            while (true) {
              const range = await findTextRange(token, docId, p.target.textToFind, instance, p.tabId);
              if (!range) break;
              ranges.push(range);
              instance++;
            }
            if (ranges.length === 0) {
              return {
                success: false,
                error: `Could not find any occurrences of text "${p.target.textToFind}"${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
              };
            }
          } else {
            const range = await findTextRange(
              token, docId, p.target.textToFind, p.target.matchInstance ?? 1, p.tabId,
            );
            if (!range) {
              return {
                success: false,
                error: `Could not find instance ${p.target.matchInstance ?? 1} of text "${p.target.textToFind}"${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
              };
            }
            ranges.push(range);
          }
        } else {
          ranges.push({ startIndex: p.target.startIndex, endIndex: p.target.endIndex });
        }

        // Build batch update requests for all ranges
        const requests: DocsRequest[] = [];
        let fields: string[] = [];
        for (const range of ranges) {
          if (range.endIndex <= range.startIndex) continue;
          const requestInfo = buildUpdateTextStyleRequest(range.startIndex, range.endIndex, p.style, p.tabId);
          if (requestInfo) {
            requests.push(requestInfo.request);
            fields = requestInfo.fields; // all have the same fields
          }
        }

        if (requests.length === 0) {
          const validKeys = ['bold', 'italic', 'underline', 'strikethrough', 'fontSize', 'fontFamily', 'foregroundColor', 'backgroundColor', 'linkUrl'];
          const rawStyle = (params as Record<string, unknown>)?.style;
          const unrecognized = rawStyle && typeof rawStyle === 'object'
            ? Object.keys(rawStyle).filter((k) => !validKeys.includes(k))
            : [];
          const hint = unrecognized.length > 0
            ? ` Unrecognized properties: ${unrecognized.join(', ')}. Valid style properties: ${validKeys.join(', ')}.`
            : ` Valid style properties: ${validKeys.join(', ')}.`;
          return { success: true, data: { message: `No valid text styling options were provided.${hint}` } };
        }

        const batchResult = await executeBatchUpdate(docId, token, requests);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to apply text style' };
        }

        const rangeDesc = ranges.length === 1
          ? `range ${ranges[0].startIndex}-${ranges[0].endIndex}`
          : `${ranges.length} occurrences`;
        return {
          success: true,
          data: {
            message: `Successfully applied text style (${fields.join(', ')}) to ${rangeDesc}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.apply_paragraph_style ─────────────────────────────────
      case 'docs.apply_paragraph_style': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          target:
            | { startIndex: number; endIndex: number }
            | { textToFind: string; matchInstance?: number }
            | { indexWithinParagraph: number };
          style: ParagraphStyleArgs;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        let startIndex: number | undefined;
        let endIndex: number | undefined;

        if ('textToFind' in p.target) {
          const textRange = await findTextRange(
            token,
            docId,
            p.target.textToFind,
            p.target.matchInstance ?? 1,
            p.tabId,
          );
          if (!textRange) {
            return {
              success: false,
              error: `Could not find "${p.target.textToFind}" in the document${p.tabId ? ` (tab: ${p.tabId})` : ''}.`,
            };
          }
          const paraRange = await getParagraphRange(token, docId, textRange.startIndex, p.tabId);
          if (!paraRange) {
            return { success: false, error: 'Found text but could not determine paragraph boundaries.' };
          }
          startIndex = paraRange.startIndex;
          endIndex = paraRange.endIndex;
        } else if ('indexWithinParagraph' in p.target) {
          const paraRange = await getParagraphRange(
            token,
            docId,
            p.target.indexWithinParagraph,
            p.tabId,
          );
          if (!paraRange) {
            return {
              success: false,
              error: `Could not find paragraph containing index ${p.target.indexWithinParagraph}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
            };
          }
          startIndex = paraRange.startIndex;
          endIndex = paraRange.endIndex;
        } else {
          startIndex = p.target.startIndex;
          endIndex = p.target.endIndex;
        }

        if (startIndex === undefined || endIndex === undefined) {
          return { success: false, error: 'Could not determine target paragraph range.' };
        }
        if (endIndex <= startIndex) {
          return { success: false, error: `Invalid range: endIndex (${endIndex}) must be > startIndex (${startIndex}).` };
        }

        const requestInfo = buildUpdateParagraphStyleRequest(startIndex, endIndex, p.style, p.tabId);
        if (!requestInfo) {
          return { success: true, data: { message: 'No valid paragraph styling options were provided.' } };
        }

        const batchResult = await executeBatchUpdate(docId, token, [requestInfo.request]);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to apply paragraph style' };
        }

        return {
          success: true,
          data: {
            message: `Successfully applied paragraph styles (${requestInfo.fields.join(', ')})${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.update_section_style ──────────────────────────────────
      case 'docs.update_section_style': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          startIndex: number;
          endIndex: number;
          flipPageOrientation?: boolean;
          sectionType?: 'SECTION_TYPE_UNSPECIFIED' | 'CONTINUOUS' | 'NEXT_PAGE';
          marginTop?: number;
          marginBottom?: number;
          marginLeft?: number;
          marginRight?: number;
          pageNumberStart?: number;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        if (p.endIndex <= p.startIndex) {
          return { success: false, error: 'endIndex must be greater than startIndex.' };
        }

        if (p.tabId) {
          const tabCheck = await fetchDocument(token, docId, {
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)',
          });
          if (!tabCheck.ok) return tabCheck.result;
          const tab = findTabById(tabCheck.doc, p.tabId);
          if (!tab) {
            return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
          }
        }

        // Build section style
        const sectionStyle: Record<string, unknown> = {};
        const fieldsToUpdate: string[] = [];

        if (p.flipPageOrientation !== undefined) {
          sectionStyle.flipPageOrientation = p.flipPageOrientation;
          fieldsToUpdate.push('flipPageOrientation');
        }
        if (p.sectionType !== undefined) {
          sectionStyle.sectionType = p.sectionType;
          fieldsToUpdate.push('sectionType');
        }
        if (p.marginTop !== undefined) {
          sectionStyle.marginTop = { magnitude: p.marginTop, unit: 'PT' };
          fieldsToUpdate.push('marginTop');
        }
        if (p.marginBottom !== undefined) {
          sectionStyle.marginBottom = { magnitude: p.marginBottom, unit: 'PT' };
          fieldsToUpdate.push('marginBottom');
        }
        if (p.marginLeft !== undefined) {
          sectionStyle.marginLeft = { magnitude: p.marginLeft, unit: 'PT' };
          fieldsToUpdate.push('marginLeft');
        }
        if (p.marginRight !== undefined) {
          sectionStyle.marginRight = { magnitude: p.marginRight, unit: 'PT' };
          fieldsToUpdate.push('marginRight');
        }
        if (p.pageNumberStart !== undefined) {
          sectionStyle.pageNumberStart = p.pageNumberStart;
          fieldsToUpdate.push('pageNumberStart');
        }

        if (fieldsToUpdate.length === 0) {
          return {
            success: false,
            error: 'No section style options provided. Set at least one of: flipPageOrientation, sectionType, marginTop, marginBottom, marginLeft, marginRight, pageNumberStart.',
          };
        }

        const range: Record<string, unknown> = {
          startIndex: p.startIndex,
          endIndex: p.endIndex,
        };
        if (p.tabId) range.tabId = p.tabId;

        const batchResult = await executeBatchUpdate(docId, token, [
          {
            updateSectionStyle: {
              range,
              sectionStyle,
              fields: fieldsToUpdate.join(','),
            },
          },
        ]);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to update section style' };
        }

        return {
          success: true,
          data: {
            message: `Successfully updated section style (${fieldsToUpdate.join(', ')}) for range ${p.startIndex}-${p.endIndex}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          },
        };
      }

      // ── docs.list_comments ─────────────────────────────────────────
      case 'docs.list_comments': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allComments: any[] = [];
        let pageToken: string | undefined;
        do {
          const qs = new URLSearchParams({
            fields: 'nextPageToken,comments(id,content,quotedFileContent,author,createdTime,resolved,replies)',
            includeDeleted: 'false',
            pageSize: '100',
          });
          if (pageToken) qs.set('pageToken', pageToken);
          const res = await driveFetchForDocs(
            `/files/${encodeURIComponent(docId)}/comments?${qs}`,
            token,
          );
          if (!res.ok) return await apiError(res, 'Drive comments');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = (await res.json()) as any;
          allComments.push(...(data.comments ?? []));
          pageToken = data.nextPageToken;
        } while (pageToken);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const comments = allComments.map((c: any) => ({
          id: c.id,
          author: c.author?.displayName || null,
          content: c.content,
          quotedText: c.quotedFileContent?.value || null,
          resolved: c.resolved || false,
          createdTime: c.createdTime,
          replyCount: c.replies?.length || 0,
        }));

        return { success: true, data: { comments } };
      }

      // ── docs.get_comment ───────────────────────────────────────────
      case 'docs.get_comment': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          commentId: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        const res = await driveFetchForDocs(
          `/files/${encodeURIComponent(docId)}/comments/${encodeURIComponent(p.commentId)}?fields=id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime)`,
          token,
        );
        if (!res.ok) return await apiError(res, 'Drive comments');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = (await res.json()) as any;
        return {
          success: true,
          data: {
            id: c.id,
            author: c.author?.displayName || null,
            content: c.content,
            quotedText: c.quotedFileContent?.value || null,
            resolved: c.resolved || false,
            createdTime: c.createdTime,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            replies: ((c.replies || []) as any[]).map((r) => ({
              id: r.id,
              author: r.author?.displayName || null,
              content: r.content,
              createdTime: r.createdTime,
            })),
          },
        };
      }

      // ── docs.add_comment ───────────────────────────────────────────
      case 'docs.add_comment': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          startIndex: number;
          endIndex: number;
          content: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        if (p.endIndex <= p.startIndex) {
          return { success: false, error: 'endIndex must be greater than startIndex.' };
        }

        // Extract the quoted text from the document
        const fetchResult = await fetchDocument(token, docId);
        if (!fetchResult.ok) return fetchResult.result;
        const bodyContent = (fetchResult.doc.body as { content?: unknown[] })?.content || [];

        let quotedText = '';
        for (const element of bodyContent as Record<string, unknown>[]) {
          const para = element.paragraph as { elements?: Record<string, unknown>[] } | undefined;
          if (para?.elements) {
            for (const pe of para.elements) {
              const textRun = pe.textRun as { content?: string } | undefined;
              const elemStart = (pe.startIndex as number) || 0;
              const elemEnd = (pe.endIndex as number) || 0;
              if (textRun?.content && elemEnd > p.startIndex && elemStart < p.endIndex) {
                const text = textRun.content;
                const startOffset = Math.max(0, p.startIndex - elemStart);
                const endOffset = Math.min(text.length, p.endIndex - elemStart);
                quotedText += text.substring(startOffset, endOffset);
              }
            }
          }
        }

        const commentRes = await driveFetchForDocs(
          `/files/${encodeURIComponent(docId)}/comments?fields=id,content,quotedFileContent,author,createdTime,resolved`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({
              content: p.content,
              quotedFileContent: {
                value: quotedText,
                mimeType: 'text/html',
              },
              anchor: JSON.stringify({
                r: docId,
                a: [
                  {
                    txt: {
                      o: p.startIndex - 1, // Drive API uses 0-based indexing
                      l: p.endIndex - p.startIndex,
                      ml: p.endIndex - p.startIndex,
                    },
                  },
                ],
              }),
            }),
          },
        );
        if (!commentRes.ok) return await apiError(commentRes, 'Drive comments');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const commentBody = (await commentRes.json()) as any;
        return {
          success: true,
          data: { message: `Comment added successfully. Comment ID: ${commentBody.id}` },
        };
      }

      // ── docs.reply_to_comment ──────────────────────────────────────
      case 'docs.reply_to_comment': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          commentId: string;
          content: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        const res = await driveFetchForDocs(
          `/files/${encodeURIComponent(docId)}/comments/${encodeURIComponent(p.commentId)}/replies?fields=id,content,author,createdTime`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({ content: p.content }),
          },
        );
        if (!res.ok) return await apiError(res, 'Drive replies');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await res.json()) as any;
        return {
          success: true,
          data: { message: `Reply added successfully. Reply ID: ${body.id}` },
        };
      }

      // ── docs.delete_comment ────────────────────────────────────────
      case 'docs.delete_comment': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          commentId: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        const res = await driveFetchForDocs(
          `/files/${encodeURIComponent(docId)}/comments/${encodeURIComponent(p.commentId)}`,
          token,
          { method: 'DELETE' },
        );
        if (!res.ok) return await apiError(res, 'Drive comments');

        return {
          success: true,
          data: { message: `Comment ${p.commentId} has been deleted.` },
        };
      }

      // ── docs.resolve_comment ───────────────────────────────────────
      case 'docs.resolve_comment': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          commentId: string;
        };
        const docId = normalizeDocumentId(p.documentId);

        // Resolve by creating a reply with action: 'resolve'
        const res = await driveFetchForDocs(
          `/files/${encodeURIComponent(docId)}/comments/${encodeURIComponent(p.commentId)}/replies?fields=id`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({ content: '', action: 'resolve' }),
          },
        );
        if (!res.ok) return await apiError(res, 'Drive comments');

        return {
          success: true,
          data: { message: `Comment ${p.commentId} has been marked as resolved.` },
        };
      }

      // ── docs.find_text_index ─────────────────────────────────────
      case 'docs.find_text_index': {
        const p = allActions.find((a) => a.id === actionId)!.params.parse(params) as {
          documentId: string;
          textToFind: string;
          matchInstance?: number;
          tabId?: string;
        };
        const docId = normalizeDocumentId(p.documentId);
        const instance = p.matchInstance ?? 1;

        const range = await findTextRange(token, docId, p.textToFind, instance, p.tabId);
        if (!range) {
          return {
            success: false,
            error: `Could not find instance ${instance} of text "${p.textToFind}"${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          };
        }

        return {
          success: true,
          data: {
            startIndex: range.startIndex,
            endIndex: range.endIndex,
            text: p.textToFind,
            instance,
            message: `Found "${p.textToFind}" (instance ${instance}) at character range [${range.startIndex}, ${range.endIndex}).`,
          },
        };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const docsActionDefs: ActionDefinition[] = allActions;
export { executeAction as executeDocsAction };
