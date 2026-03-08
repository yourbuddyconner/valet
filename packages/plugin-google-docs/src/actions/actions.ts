import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { docsFetch, driveFetch, apiError, executeBatchUpdate } from './api.js';
import { docsToMarkdown } from './docs-to-markdown.js';
import type { DocsBody, DocsLists } from './docs-to-markdown.js';
import { convertMarkdownToRequests } from './markdown-to-docs.js';
import { findSection, getBodyEndIndex } from './sections.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Escape a string value for use inside a Drive API query `q` parameter. */
function escapeDriveQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Fetch a full document and return the parsed JSON. */
async function fetchDocument(
  documentId: string,
  token: string,
): Promise<{ ok: true; doc: Record<string, unknown> } | { ok: false; error: ActionResult }> {
  const res = await docsFetch(`/documents/${encodeURIComponent(documentId)}`, token);
  if (!res.ok) {
    return { ok: false, error: await apiError(res, 'Docs') };
  }
  const doc = (await res.json()) as Record<string, unknown>;
  return { ok: true, doc };
}

/**
 * Extract a section from rendered markdown by heading text.
 * Finds the heading line and returns everything until the next heading of
 * equal or higher level (fewer or equal '#' characters).
 */
function extractMarkdownSection(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n');
  const needle = heading.toLowerCase();

  let sectionStart = -1;
  let sectionLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!match) continue;

    const level = match[1].length;
    const text = match[2].trim();

    if (sectionStart === -1) {
      // Looking for the target heading
      if (text.toLowerCase().includes(needle)) {
        sectionStart = i;
        sectionLevel = level;
      }
    } else {
      // Found start, looking for end
      if (level <= sectionLevel) {
        return lines.slice(sectionStart, i).join('\n').trim();
      }
    }
  }

  if (sectionStart !== -1) {
    return lines.slice(sectionStart).join('\n').trim();
  }

  return null;
}

// ─── Action Definitions ──────────────────────────────────────────────────────

const searchDocuments: ActionDefinition = {
  id: 'docs.search_documents',
  name: 'Search Documents',
  description: 'Search Google Docs by full-text query',
  riskLevel: 'low',
  params: z.object({
    query: z.string().describe('Search text (matches document names and content)'),
    maxResults: z.number().int().min(1).max(50).optional().describe('Max results to return (default: 20, max: 50)'),
  }),
};

const getDocument: ActionDefinition = {
  id: 'docs.get_document',
  name: 'Get Document',
  description: 'Get document metadata (title, revision ID) by ID',
  riskLevel: 'low',
  params: z.object({
    documentId: z.string().describe('Google Docs document ID'),
  }),
};

const readDocument: ActionDefinition = {
  id: 'docs.read_document',
  name: 'Read Document',
  description: 'Read the full content of a Google Doc as markdown',
  riskLevel: 'low',
  params: z.object({
    documentId: z.string().describe('Google Docs document ID'),
    tabId: z.string().optional().describe('Specific tab ID to read (for multi-tab documents)'),
  }),
};

const readSection: ActionDefinition = {
  id: 'docs.read_section',
  name: 'Read Section',
  description: 'Read a specific section of a Google Doc by heading text',
  riskLevel: 'low',
  params: z.object({
    documentId: z.string().describe('Google Docs document ID'),
    heading: z.string().describe('Heading text to find (case-insensitive substring match)'),
    tabId: z.string().optional().describe('Specific tab ID (for multi-tab docs)'),
  }),
};

const createDocument: ActionDefinition = {
  id: 'docs.create_document',
  name: 'Create Document',
  description: 'Create a new Google Doc with optional markdown content',
  riskLevel: 'medium',
  params: z.object({
    title: z.string().describe('Document title'),
    markdown: z.string().describe('Markdown content for the document body'),
    folderId: z.string().optional().describe('Google Drive folder ID to place the document in'),
  }),
};

const replaceDocument: ActionDefinition = {
  id: 'docs.replace_document',
  name: 'Replace Document',
  description: 'Replace the entire content of a Google Doc with new markdown',
  riskLevel: 'high',
  params: z.object({
    documentId: z.string().describe('Google Docs document ID'),
    markdown: z.string().describe('New markdown content to replace the entire document body'),
  }),
};

const appendContent: ActionDefinition = {
  id: 'docs.append_content',
  name: 'Append Content',
  description: 'Append markdown content to the end of a Google Doc',
  riskLevel: 'medium',
  params: z.object({
    documentId: z.string().describe('Google Docs document ID'),
    markdown: z.string().describe('Markdown content to append'),
  }),
};

const replaceSection: ActionDefinition = {
  id: 'docs.replace_section',
  name: 'Replace Section',
  description: 'Replace a specific section of a Google Doc identified by heading',
  riskLevel: 'medium',
  params: z.object({
    documentId: z.string().describe('Google Docs document ID'),
    heading: z.string().describe('Heading text of the section to replace (case-insensitive substring match)'),
    markdown: z.string().describe('New markdown content to replace the section with'),
  }),
};

const insertSection: ActionDefinition = {
  id: 'docs.insert_section',
  name: 'Insert Section',
  description: 'Insert markdown content before or after a specific section',
  riskLevel: 'medium',
  params: z.object({
    documentId: z.string().describe('Google Docs document ID'),
    heading: z.string().describe('Heading text of the reference section (case-insensitive substring match)'),
    position: z.enum(['before', 'after']).describe('Insert before or after the reference section'),
    markdown: z.string().describe('Markdown content to insert'),
  }),
};

const deleteSection: ActionDefinition = {
  id: 'docs.delete_section',
  name: 'Delete Section',
  description: 'Delete a section (heading and all content until next same-level heading) from a Google Doc',
  riskLevel: 'high',
  params: z.object({
    documentId: z.string().describe('Google Docs document ID'),
    heading: z.string().describe('Heading text of the section to delete (case-insensitive substring match)'),
  }),
};

// ─── Action List ─────────────────────────────────────────────────────────────

const allActions: ActionDefinition[] = [
  searchDocuments,
  getDocument,
  readDocument,
  readSection,
  createDocument,
  replaceDocument,
  appendContent,
  replaceSection,
  insertSection,
  deleteSection,
];

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
      case 'docs.search_documents': {
        const p = searchDocuments.params.parse(params);
        const maxResults = Math.min(p.maxResults ?? 20, 50);
        const q = `fullText contains '${escapeDriveQuery(p.query)}' and mimeType='application/vnd.google-apps.document' and trashed = false`;
        const qs = new URLSearchParams({
          q,
          fields: 'files(id,name,modifiedTime,webViewLink)',
          pageSize: String(maxResults),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        const res = await driveFetch(`/files?${qs}`, token);
        if (!res.ok) return await apiError(res, 'Drive');
        const data = (await res.json()) as { files: unknown[] };
        return { success: true, data: { files: data.files || [] } };
      }

      case 'docs.get_document': {
        const { documentId } = getDocument.params.parse(params);
        const result = await fetchDocument(documentId, token);
        if (!result.ok) return result.error;
        const doc = result.doc as { documentId?: string; title?: string; revisionId?: string };
        return {
          success: true,
          data: {
            documentId: doc.documentId,
            title: doc.title,
            revisionId: doc.revisionId,
          },
        };
      }

      case 'docs.read_document': {
        const { documentId, tabId } = readDocument.params.parse(params);
        const result = await fetchDocument(documentId, token);
        if (!result.ok) return result.error;
        const doc = result.doc;

        let body: DocsBody;
        let lists: DocsLists | undefined;

        if (tabId) {
          // Find specific tab in includeTabsContent
          const tabs = (doc as { tabs?: Array<{ tabProperties?: { tabId?: string }; body?: DocsBody; documentTab?: { body?: DocsBody; lists?: DocsLists } }> }).tabs;
          const tab = tabs?.find((t) => t.tabProperties?.tabId === tabId);
          if (!tab) {
            return { success: false, error: `Tab '${tabId}' not found in document` };
          }
          body = tab.documentTab?.body ?? tab.body ?? {};
          lists = tab.documentTab?.lists;
        } else {
          body = (doc.body ?? {}) as DocsBody;
          lists = doc.lists as DocsLists | undefined;
        }

        const markdown = docsToMarkdown(body, lists);
        return { success: true, data: { markdown } };
      }

      case 'docs.read_section': {
        const { documentId, heading, tabId } = readSection.params.parse(params);
        const result = await fetchDocument(documentId, token);
        if (!result.ok) return result.error;
        const doc = result.doc;

        let body: DocsBody;
        let lists: DocsLists | undefined;

        if (tabId) {
          const tabs = (doc as { tabs?: Array<{ tabProperties?: { tabId?: string }; body?: DocsBody; documentTab?: { body?: DocsBody; lists?: DocsLists } }> }).tabs;
          const tab = tabs?.find((t) => t.tabProperties?.tabId === tabId);
          if (!tab) {
            return { success: false, error: `Tab '${tabId}' not found in document` };
          }
          body = tab.documentTab?.body ?? tab.body ?? {};
          lists = tab.documentTab?.lists;
        } else {
          body = (doc.body ?? {}) as DocsBody;
          lists = doc.lists as DocsLists | undefined;
        }

        const markdown = docsToMarkdown(body, lists);

        const sectionMarkdown = extractMarkdownSection(markdown, heading);
        if (sectionMarkdown === null) {
          return { success: false, error: `Section with heading matching '${heading}' not found` };
        }

        return { success: true, data: { markdown: sectionMarkdown } };
      }

      case 'docs.create_document': {
        const { title, markdown, folderId } = createDocument.params.parse(params);

        // 1. Create empty document
        const createRes = await docsFetch('/documents', token, {
          method: 'POST',
          body: JSON.stringify({ title }),
        });
        if (!createRes.ok) return await apiError(createRes, 'Docs');
        const newDoc = (await createRes.json()) as { documentId: string; title: string };

        // 2. If markdown provided, insert content
        if (markdown && markdown.trim()) {
          const requests = convertMarkdownToRequests(markdown);
          if (requests.length > 0) {
            const batchResult = await executeBatchUpdate(newDoc.documentId, token, requests);
            if (!batchResult.success) {
              return { success: false, error: batchResult.error || 'Failed to insert content' };
            }
          }
        }

        // 3. If folderId, move the document into the folder
        if (folderId) {
          const moveRes = await driveFetch(
            `/files/${encodeURIComponent(newDoc.documentId)}?addParents=${encodeURIComponent(folderId)}&fields=id`,
            token,
            { method: 'PATCH', body: JSON.stringify({}) },
          );
          if (!moveRes.ok) {
            // Document was created but move failed — report partial success
            return {
              success: true,
              data: {
                documentId: newDoc.documentId,
                title: newDoc.title,
                webViewLink: `https://docs.google.com/document/d/${newDoc.documentId}/edit`,
                warning: `Document created but could not be moved to folder ${folderId}`,
              },
            };
          }
        }

        return {
          success: true,
          data: {
            documentId: newDoc.documentId,
            title: newDoc.title,
            webViewLink: `https://docs.google.com/document/d/${newDoc.documentId}/edit`,
          },
        };
      }

      case 'docs.replace_document': {
        const { documentId, markdown } = replaceDocument.params.parse(params);

        // 1. Get current document body
        const result = await fetchDocument(documentId, token);
        if (!result.ok) return result.error;
        const body = (result.doc.body ?? {}) as DocsBody;
        const endIndex = getBodyEndIndex(body);

        const requests = [];

        // 2. Delete existing content (if any beyond the initial newline)
        if (endIndex > 2) {
          requests.push({
            deleteContentRange: {
              range: { startIndex: 1, endIndex: endIndex - 1 },
            },
          });
        }

        // 3. Insert new content
        const insertRequests = convertMarkdownToRequests(markdown);
        requests.push(...insertRequests);

        // 4. Execute batch update
        const batchResult = await executeBatchUpdate(documentId, token, requests);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to replace document content' };
        }

        return { success: true, data: { documentId } };
      }

      case 'docs.append_content': {
        const { documentId, markdown } = appendContent.params.parse(params);

        // 1. Get current document body to find end index
        const result = await fetchDocument(documentId, token);
        if (!result.ok) return result.error;
        const body = (result.doc.body ?? {}) as DocsBody;
        const endIndex = getBodyEndIndex(body);

        // 2. Convert markdown to requests starting at end of document
        const requests = convertMarkdownToRequests(markdown, { startIndex: endIndex - 1 });

        // 3. Execute batch update
        const batchResult = await executeBatchUpdate(documentId, token, requests);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to append content' };
        }

        return { success: true, data: { documentId } };
      }

      case 'docs.replace_section': {
        const { documentId, heading, markdown } = replaceSection.params.parse(params);

        // 1. Get current document body
        const result = await fetchDocument(documentId, token);
        if (!result.ok) return result.error;
        const body = (result.doc.body ?? {}) as DocsBody;

        // 2. Find the section
        const section = findSection(body, heading);
        if (!section) {
          return { success: false, error: `Section with heading matching '${heading}' not found` };
        }

        const requests = [];

        // 3. Delete section content
        if (section.endIndex > section.startIndex) {
          requests.push({
            deleteContentRange: {
              range: { startIndex: section.startIndex, endIndex: section.endIndex },
            },
          });
        }

        // 4. Insert new content at section start
        const insertRequests = convertMarkdownToRequests(markdown, { startIndex: section.startIndex });
        requests.push(...insertRequests);

        // 5. Execute batch update
        const batchResult = await executeBatchUpdate(documentId, token, requests);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to replace section' };
        }

        return { success: true, data: { documentId } };
      }

      case 'docs.insert_section': {
        const { documentId, heading, position, markdown } = insertSection.params.parse(params);

        // 1. Get current document body
        const result = await fetchDocument(documentId, token);
        if (!result.ok) return result.error;
        const body = (result.doc.body ?? {}) as DocsBody;

        // 2. Find the reference section
        const section = findSection(body, heading);
        if (!section) {
          return { success: false, error: `Section with heading matching '${heading}' not found` };
        }

        // 3. Determine insert index
        const insertIndex = position === 'before' ? section.startIndex : section.endIndex;

        // 4. Convert markdown to requests at insert point
        const requests = convertMarkdownToRequests(markdown, { startIndex: insertIndex });

        // 5. Execute batch update
        const batchResult = await executeBatchUpdate(documentId, token, requests);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to insert section' };
        }

        return { success: true, data: { documentId } };
      }

      case 'docs.delete_section': {
        const { documentId, heading } = deleteSection.params.parse(params);

        // 1. Get current document body
        const result = await fetchDocument(documentId, token);
        if (!result.ok) return result.error;
        const body = (result.doc.body ?? {}) as DocsBody;

        // 2. Find the section
        const section = findSection(body, heading);
        if (!section) {
          return { success: false, error: `Section with heading matching '${heading}' not found` };
        }

        // 3. Delete the section
        if (section.endIndex <= section.startIndex) {
          return { success: true, data: { documentId } }; // Empty section, nothing to delete
        }

        const requests = [
          {
            deleteContentRange: {
              range: { startIndex: section.startIndex, endIndex: section.endIndex },
            },
          },
        ];

        const batchResult = await executeBatchUpdate(documentId, token, requests);
        if (!batchResult.success) {
          return { success: false, error: batchResult.error || 'Failed to delete section' };
        }

        return { success: true, data: { documentId } };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const googleDocsActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
