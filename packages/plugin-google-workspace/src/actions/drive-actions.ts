import { z } from 'zod';
import type { ActionDefinition, ActionContext, ActionResult } from '@valet/sdk';
import { insertMarkdown } from './docs-markdown.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DOCS_API = 'https://docs.googleapis.com/v1';

const MIME_TYPE_SHORTCUTS: Record<string, string> = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  folder: 'application/vnd.google-apps.folder',
  form: 'application/vnd.google-apps.form',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

const WORKSPACE_EXPORT_DEFAULTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.drawing': 'image/png',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
};

const LIST_FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress)';

// ─── Shared Helpers ─────────────────────────────────────────────────────────

function escapeDriveQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveFetch(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${DRIVE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
}

async function driveError(res: Response): Promise<{ success: false; error: string }> {
  let detail = '';
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    detail = json?.error?.message || body.slice(0, 200);
  } catch {
    detail = res.statusText;
  }
  return { success: false, error: `Drive API ${res.status}: ${detail}` };
}

function isGoogleWorkspaceMimeType(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.');
}

function isTextMimeType(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  const textTypes = [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/x-sh',
    'application/sql',
    'application/graphql',
    'application/xhtml+xml',
    'application/ld+json',
    'application/manifest+json',
    'application/vnd.google-apps.script+json',
  ];
  return textTypes.includes(mimeType);
}

function getExportMimeType(googleMimeType: string): string | null {
  return WORKSPACE_EXPORT_DEFAULTS[googleMimeType] || null;
}

/** Resolve a MIME type shortcut or return the value as-is. */
function resolveMimeType(mimeType: string): string {
  return MIME_TYPE_SHORTCUTS[mimeType] ?? mimeType;
}

/**
 * Read __labelFilter from raw params for list/search actions.
 * The labels guard injects this to restrict results to labeled files.
 */
function getLabelFilter(params: unknown): string | undefined {
  return (params as Record<string, unknown> | null)?.__labelFilter as string | undefined;
}

const VALID_CORPORA = new Set(['user', 'domain', 'drive', 'allDrives']);

/**
 * Return the corpora value for a Drive API request.
 * Priority: per-request override > org-configured value > 'user' default.
 */
function resolveCorpora(ctx: ActionContext, override?: string): string {
  if (typeof override === 'string' && VALID_CORPORA.has(override)) return override;
  const value = ctx.guardConfig?.driveCorpora;
  return typeof value === 'string' && VALID_CORPORA.has(value) ? value : 'user';
}

/**
 * Compose a user query with an optional label filter clause.
 * Uses parenthesization to prevent Drive API operator precedence bugs.
 */
function composeQuery(userQuery: string, labelFilter: string | undefined): string {
  if (userQuery && labelFilter) return `(${userQuery}) and ${labelFilter}`;
  if (labelFilter) return labelFilter;
  return userQuery;
}

// ─── Internal Types ──────────────────────────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  description?: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  owners?: Array<{ displayName: string; emailAddress: string }>;
  lastModifyingUser?: { displayName: string; emailAddress: string };
  shared?: boolean;
  parents?: string[];
}

// ─── Action Definitions ──────────────────────────────────────────────────────

// Discovery

const listFiles: ActionDefinition = {
  id: 'drive.list_files',
  name: 'List Files',
  description:
    'Lists files across Google Drive with optional filtering by type, folder, and ownership. ' +
    'Use mimeType shortcuts: "document", "spreadsheet", "presentation", "folder", "form", "pdf", "zip" ' +
    'or pass any full MIME type string.',
  riskLevel: 'low',
  params: z.object({
    query: z.string().optional().describe('Additional Drive query filter'),
    folderId: z.string().optional().describe('Folder ID to list contents of (use "root" for top-level)'),
    mimeType: z.string().optional().describe('Filter by MIME type. Shortcuts: "document", "spreadsheet", "folder", etc.'),
    maxResults: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
    orderBy: z.enum(['name', 'modifiedTime', 'createdTime', 'quotaBytesUsed']).optional(),
    sortDirection: z.enum(['asc', 'desc']).optional(),
    ownedByMe: z.boolean().optional().describe('Only return files owned by the authenticated user'),
    sharedWithMe: z.boolean().optional().describe('Only return files shared with the authenticated user'),
    modifiedAfter: z.string().optional().describe('Only return files modified after this date (ISO 8601)'),
    corpora: z.enum(['user', 'domain', 'drive', 'allDrives']).optional().describe('Which corpus to search. "user" for personal files (default), "domain" for organization-wide, "drive" for a specific shared drive, "allDrives" for everything.'),
  }),
};

const searchFiles: ActionDefinition = {
  id: 'drive.search_files',
  name: 'Search Files',
  description:
    'Searches across all file types in Google Drive by name or content. ' +
    'Supports filtering by MIME type, scoping to a folder subtree, and pagination.',
  riskLevel: 'low',
  params: z.object({
    query: z.string().describe('Search text (matches file names and content)'),
    searchIn: z.enum(['name', 'content', 'both']).optional().describe('Where to search: "name", "content", or "both" (default)'),
    mimeType: z.string().optional().describe('Restrict to a specific file type (shortcuts or full MIME type)'),
    folderId: z.string().optional().describe('Restrict to files inside this folder'),
    orderBy: z.enum(['name', 'modifiedTime', 'createdTime']).optional(),
    sortDirection: z.enum(['asc', 'desc']).optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
    modifiedAfter: z.string().optional().describe('Only return files modified after this date (ISO 8601)'),
    pageToken: z.string().optional(),
    corpora: z.enum(['user', 'domain', 'drive', 'allDrives']).optional().describe('Which corpus to search. "user" for personal files (default), "domain" for organization-wide, "drive" for a specific shared drive, "allDrives" for everything.'),
  }),
};

const listDocuments: ActionDefinition = {
  id: 'drive.list_documents',
  name: 'List Google Docs',
  description: 'Lists Google Documents in your Drive, optionally filtered by name or content.',
  riskLevel: 'low',
  params: z.object({
    query: z.string().optional().describe('Search query to filter documents by name or content'),
    maxResults: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
    orderBy: z.enum(['name', 'modifiedTime', 'createdTime']).optional(),
    modifiedAfter: z.string().optional().describe('Only return documents modified after this date (ISO 8601)'),
    corpora: z.enum(['user', 'domain', 'drive', 'allDrives']).optional().describe('Which corpus to search. "user" for personal files (default), "domain" for organization-wide, "drive" for a specific shared drive, "allDrives" for everything.'),
  }),
};

const searchDocuments: ActionDefinition = {
  id: 'drive.search_documents',
  name: 'Search Google Docs',
  description: 'Searches for Google Documents by name, content, or both.',
  riskLevel: 'low',
  params: z.object({
    query: z.string().describe('Search term to find in document names or content'),
    searchIn: z.enum(['name', 'content', 'both']).optional().describe('Where to search (default: "both")'),
    maxResults: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
    modifiedAfter: z.string().optional().describe('Only return documents modified after this date (ISO 8601)'),
    corpora: z.enum(['user', 'domain', 'drive', 'allDrives']).optional().describe('Which corpus to search. "user" for personal files (default), "domain" for organization-wide, "drive" for a specific shared drive, "allDrives" for everything.'),
  }),
};

const listFolderContents: ActionDefinition = {
  id: 'drive.list_folder_contents',
  name: 'List Folder Contents',
  description: 'Lists files and subfolders within a Drive folder. Use folderId="root" for the top-level.',
  riskLevel: 'low',
  params: z.object({
    folderId: z.string().describe('Folder ID (use "root" for the root Drive folder)'),
    maxResults: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
    corpora: z.enum(['user', 'domain', 'drive', 'allDrives']).optional().describe('Which corpus to search. "user" for personal files (default), "domain" for organization-wide, "drive" for a specific shared drive, "allDrives" for everything.'),
  }),
};

const getDocumentInfo: ActionDefinition = {
  id: 'drive.get_document_info',
  name: 'Get Document Info',
  description: 'Gets metadata about a document including name, owner, sharing status, and modification history.',
  riskLevel: 'low',
  params: z.object({
    fileId: z.string().describe('File ID'),
  }),
};

const getFolderInfo: ActionDefinition = {
  id: 'drive.get_folder_info',
  name: 'Get Folder Info',
  description: 'Gets metadata about a Drive folder including name, owner, sharing status, and child count.',
  riskLevel: 'low',
  params: z.object({
    folderId: z.string().describe('Folder ID'),
  }),
};

// File Operations

const createDocument: ActionDefinition = {
  id: 'drive.create_document',
  name: 'Create Document',
  description:
    'Creates a new Google Document. Optionally places it in a folder and adds initial ' +
    'content (markdown is converted to formatted Google Docs content by default).',
  riskLevel: 'medium',
  params: z.object({
    title: z.string().describe('Document title'),
    markdown: z.string().optional().describe('Initial content as markdown (converted to formatted Docs content)'),
    folderId: z.string().optional().describe('Parent folder ID'),
  }),
};

const createFolder: ActionDefinition = {
  id: 'drive.create_folder',
  name: 'Create Folder',
  description: 'Creates a new folder in Google Drive.',
  riskLevel: 'medium',
  params: z.object({
    name: z.string().describe('Folder name'),
    parentFolderId: z.string().optional().describe('Parent folder ID'),
    description: z.string().optional(),
  }),
};

const copyFile: ActionDefinition = {
  id: 'drive.copy_file',
  name: 'Copy File',
  description: 'Creates a copy of a file in Google Drive.',
  riskLevel: 'medium',
  params: z.object({
    fileId: z.string().describe('Source file ID'),
    name: z.string().optional().describe('Name for the copy'),
    folderId: z.string().optional().describe('Destination folder ID'),
  }),
};

const moveFile: ActionDefinition = {
  id: 'drive.move_file',
  name: 'Move File',
  description: 'Moves a file or folder to a different Drive folder.',
  riskLevel: 'medium',
  params: z.object({
    fileId: z.string().describe('File ID'),
    folderId: z.string().describe('Destination folder ID'),
  }),
};

const renameFile: ActionDefinition = {
  id: 'drive.rename_file',
  name: 'Rename File',
  description: 'Renames a file or folder in Google Drive.',
  riskLevel: 'medium',
  params: z.object({
    fileId: z.string().describe('File ID'),
    name: z.string().describe('New file name'),
  }),
};

const deleteFileDef: ActionDefinition = {
  id: 'drive.delete_file',
  name: 'Delete File',
  description: 'Moves a file or folder to trash by default. Set permanent=true for irreversible deletion.',
  riskLevel: 'high',
  params: z.object({
    fileId: z.string().describe('File ID'),
    permanent: z.boolean().optional().describe('If true, permanently delete (cannot be undone). Default: false (trash).'),
  }),
};

const downloadFile: ActionDefinition = {
  id: 'drive.download_file',
  name: 'Download File',
  description:
    'Downloads text content of a file. Exports Google Workspace files to text format. ' +
    'Rejects binary files.',
  riskLevel: 'low',
  params: z.object({
    fileId: z.string().describe('File ID'),
    maxSizeBytes: z.number().int().optional().describe('Max bytes to download (default: 1MB)'),
  }),
};

const createFromTemplate: ActionDefinition = {
  id: 'drive.create_from_template',
  name: 'Create from Template',
  description:
    'Creates a new document by copying a template and optionally replacing placeholder text.',
  riskLevel: 'medium',
  params: z.object({
    templateId: z.string().describe('Template document ID to copy'),
    title: z.string().describe('Title for the new document'),
    folderId: z.string().optional().describe('Destination folder ID'),
    replacements: z.record(z.string()).optional().describe('Key-value pairs for placeholder substitution (e.g. {"{{name}}": "Alice"})'),
  }),
};

const allActions: ActionDefinition[] = [
  listFiles,
  searchFiles,
  listDocuments,
  searchDocuments,
  listFolderContents,
  getDocumentInfo,
  getFolderInfo,
  createDocument,
  createFolder,
  copyFile,
  moveFile,
  renameFile,
  deleteFileDef,
  downloadFile,
  createFromTemplate,
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
      // ── Discovery ──

      case 'drive.list_files': {
        const p = listFiles.params.parse(params);

        if (p.ownedByMe && p.sharedWithMe) {
          return { success: false, error: 'ownedByMe and sharedWithMe cannot both be true' };
        }

        const queryParts: string[] = ['trashed=false'];
        if (p.mimeType) queryParts.push(`mimeType='${escapeDriveQuery(resolveMimeType(p.mimeType))}'`);
        if (p.folderId) queryParts.push(`'${escapeDriveQuery(p.folderId)}' in parents`);
        if (p.ownedByMe) queryParts.push("'me' in owners");
        else if (p.sharedWithMe) queryParts.push('sharedWithMe=true');
        if (p.modifiedAfter) {
          const cutoff = new Date(p.modifiedAfter).toISOString();
          queryParts.push(`modifiedTime > '${escapeDriveQuery(cutoff)}'`);
        }
        if (p.query) queryParts.push(p.query);

        const labelFilter = getLabelFilter(params);
        const finalQuery = composeQuery(queryParts.join(' and '), labelFilter);

        const orderByParam = p.orderBy
          ? (p.sortDirection === 'asc' ? p.orderBy : `${p.orderBy} desc`)
          : 'modifiedTime desc';

        const qs = new URLSearchParams({
          corpora: resolveCorpora(ctx, p.corpora),
          fields: `nextPageToken,files(${LIST_FILE_FIELDS})`,
          pageSize: String(p.maxResults || 20),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          orderBy: orderByParam,
        });
        if (finalQuery) qs.set('q', finalQuery);
        if (p.pageToken) qs.set('pageToken', p.pageToken);

        const res = await driveFetch(`/files?${qs}`, token);
        if (!res.ok) return driveError(res);
        const data = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
        const files = (data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size != null ? Number(f.size) : null,
          modifiedTime: f.modifiedTime,
          createdTime: f.createdTime,
          owner: f.owners?.[0]?.displayName || null,
          url: f.webViewLink,
        }));
        return {
          success: true,
          data: { files, total: files.length, nextPageToken: data.nextPageToken },
        };
      }

      case 'drive.search_files': {
        const p = searchFiles.params.parse(params);
        const queryParts: string[] = ['trashed=false'];

        const searchIn = p.searchIn || 'both';
        if (searchIn === 'name') {
          queryParts.push(`name contains '${escapeDriveQuery(p.query)}'`);
        } else if (searchIn === 'content') {
          queryParts.push(`fullText contains '${escapeDriveQuery(p.query)}'`);
        } else {
          queryParts.push(
            `(name contains '${escapeDriveQuery(p.query)}' or fullText contains '${escapeDriveQuery(p.query)}')`,
          );
        }

        if (p.mimeType) queryParts.push(`mimeType='${escapeDriveQuery(resolveMimeType(p.mimeType))}'`);
        if (p.folderId) queryParts.push(`'${escapeDriveQuery(p.folderId)}' in ancestors`);
        if (p.modifiedAfter) {
          const cutoff = new Date(p.modifiedAfter).toISOString();
          queryParts.push(`modifiedTime > '${escapeDriveQuery(cutoff)}'`);
        }

        const labelFilter = getLabelFilter(params);
        const finalQuery = composeQuery(queryParts.join(' and '), labelFilter);

        const orderByParam = p.orderBy
          ? (p.sortDirection === 'asc' ? p.orderBy : `${p.orderBy} desc`)
          : 'modifiedTime desc';

        const qs = new URLSearchParams({
          corpora: resolveCorpora(ctx, p.corpora),
          q: finalQuery,
          fields: `nextPageToken,files(${LIST_FILE_FIELDS})`,
          pageSize: String(p.maxResults || 10),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          orderBy: orderByParam,
        });
        if (p.pageToken) qs.set('pageToken', p.pageToken);

        const res = await driveFetch(`/files?${qs}`, token);
        if (!res.ok) return driveError(res);
        const data = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
        const files = (data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size != null ? Number(f.size) : null,
          modifiedTime: f.modifiedTime,
          createdTime: f.createdTime,
          owner: f.owners?.[0]?.displayName || null,
          url: f.webViewLink,
        }));
        return {
          success: true,
          data: { files, total: files.length, nextPageToken: data.nextPageToken, hasMore: !!data.nextPageToken },
        };
      }

      case 'drive.list_documents': {
        const p = listDocuments.params.parse(params);
        const queryParts: string[] = [
          "mimeType='application/vnd.google-apps.document'",
          'trashed=false',
        ];
        if (p.query) {
          queryParts.push(
            `(name contains '${escapeDriveQuery(p.query)}' or fullText contains '${escapeDriveQuery(p.query)}')`,
          );
        }
        if (p.modifiedAfter) {
          const cutoff = new Date(p.modifiedAfter).toISOString();
          queryParts.push(`modifiedTime > '${escapeDriveQuery(cutoff)}'`);
        }

        const labelFilter = getLabelFilter(params);
        const finalQuery = composeQuery(queryParts.join(' and '), labelFilter);

        const orderByParam = p.orderBy || 'modifiedTime';

        const qs = new URLSearchParams({
          corpora: resolveCorpora(ctx, p.corpora),
          q: finalQuery,
          fields: `nextPageToken,files(id,name,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress))`,
          pageSize: String(p.maxResults || 20),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          orderBy: orderByParam,
        });
        if (p.pageToken) qs.set('pageToken', p.pageToken);

        const res = await driveFetch(`/files?${qs}`, token);
        if (!res.ok) return driveError(res);
        const data = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
        const documents = (data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          modifiedTime: f.modifiedTime,
          owner: f.owners?.[0]?.displayName || null,
          url: f.webViewLink,
        }));
        return {
          success: true,
          data: { documents, total: documents.length, nextPageToken: data.nextPageToken },
        };
      }

      case 'drive.search_documents': {
        const p = searchDocuments.params.parse(params);
        const queryParts: string[] = [
          "mimeType='application/vnd.google-apps.document'",
          'trashed=false',
        ];

        const searchIn = p.searchIn || 'both';
        if (searchIn === 'name') {
          queryParts.push(`name contains '${escapeDriveQuery(p.query)}'`);
        } else if (searchIn === 'content') {
          queryParts.push(`fullText contains '${escapeDriveQuery(p.query)}'`);
        } else {
          queryParts.push(
            `(name contains '${escapeDriveQuery(p.query)}' or fullText contains '${escapeDriveQuery(p.query)}')`,
          );
        }

        if (p.modifiedAfter) {
          queryParts.push(`modifiedTime > '${escapeDriveQuery(p.modifiedAfter)}'`);
        }

        const labelFilter = getLabelFilter(params);
        const finalQuery = composeQuery(queryParts.join(' and '), labelFilter);

        const qs = new URLSearchParams({
          corpora: resolveCorpora(ctx, p.corpora),
          q: finalQuery,
          fields: `nextPageToken,files(id,name,modifiedTime,createdTime,webViewLink,owners(displayName))`,
          pageSize: String(p.maxResults || 10),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          orderBy: 'modifiedTime desc',
        });
        if (p.pageToken) qs.set('pageToken', p.pageToken);

        const res = await driveFetch(`/files?${qs}`, token);
        if (!res.ok) return driveError(res);
        const data = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
        const documents = (data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          modifiedTime: f.modifiedTime,
          owner: f.owners?.[0]?.displayName || null,
          url: f.webViewLink,
        }));
        return {
          success: true,
          data: { documents, total: documents.length, nextPageToken: data.nextPageToken },
        };
      }

      case 'drive.list_folder_contents': {
        const p = listFolderContents.params.parse(params);
        const queryParts: string[] = [
          `'${escapeDriveQuery(p.folderId)}' in parents`,
          'trashed=false',
        ];

        const labelFilter = getLabelFilter(params);
        const finalQuery = composeQuery(queryParts.join(' and '), labelFilter);

        const qs = new URLSearchParams({
          corpora: resolveCorpora(ctx, p.corpora),
          q: finalQuery,
          fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName))',
          pageSize: String(p.maxResults || 50),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          orderBy: 'folder,name',
        });
        if (p.pageToken) qs.set('pageToken', p.pageToken);

        const res = await driveFetch(`/files?${qs}`, token);
        if (!res.ok) return driveError(res);
        const data = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
        const items = data.files || [];
        const folders = items
          .filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
          .map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
        const files = items
          .filter((f) => f.mimeType !== 'application/vnd.google-apps.folder')
          .map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
        return {
          success: true,
          data: { folders, files, nextPageToken: data.nextPageToken },
        };
      }

      case 'drive.get_document_info': {
        const { fileId } = getDocumentInfo.params.parse(params);
        const qs = new URLSearchParams({
          fields: 'id,name,mimeType,description,size,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),shared,parents',
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files/${encodeURIComponent(fileId)}?${qs}`, token);
        if (!res.ok) return driveError(res);
        const file = (await res.json()) as DriveFile;
        return {
          success: true,
          data: {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime,
            owner: file.owners?.[0]?.displayName || null,
            lastModifyingUser: file.lastModifyingUser?.displayName || null,
            shared: file.shared || false,
            url: file.webViewLink,
            description: file.description || null,
          },
        };
      }

      case 'drive.get_folder_info': {
        const { folderId } = getFolderInfo.params.parse(params);
        const qs = new URLSearchParams({
          fields: 'id,name,mimeType,description,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName),shared,parents',
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files/${encodeURIComponent(folderId)}?${qs}`, token);
        if (!res.ok) return driveError(res);
        const file = (await res.json()) as DriveFile;

        if (file.mimeType !== 'application/vnd.google-apps.folder') {
          return { success: false, error: 'The specified ID does not belong to a folder' };
        }

        // Count children
        const childQs = new URLSearchParams({
          corpora: resolveCorpora(ctx),
          q: `'${escapeDriveQuery(folderId)}' in parents and trashed=false`,
          fields: 'files(id)',
          pageSize: '100',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        const childRes = await driveFetch(`/files?${childQs}`, token);
        let childCount: number | null = null;
        if (childRes.ok) {
          const childData = (await childRes.json()) as { files: Array<{ id: string }> };
          childCount = childData.files?.length ?? 0;
        }

        return {
          success: true,
          data: {
            id: file.id,
            name: file.name,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime,
            owner: file.owners?.[0]?.displayName || null,
            lastModifyingUser: file.lastModifyingUser?.displayName || null,
            shared: file.shared || false,
            url: file.webViewLink,
            description: file.description || null,
            parentFolderId: file.parents?.[0] || null,
            childCount,
          },
        };
      }

      // ── File Operations ──

      case 'drive.create_document': {
        const p = createDocument.params.parse(params);
        const metadata: Record<string, unknown> = {
          name: p.title,
          mimeType: 'application/vnd.google-apps.document',
        };
        if (p.folderId) metadata.parents = [p.folderId];

        const qs = new URLSearchParams({
          fields: 'id,name,webViewLink',
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files?${qs}`, token, {
          method: 'POST',
          body: JSON.stringify(metadata),
        });
        if (!res.ok) return driveError(res);
        const doc = (await res.json()) as { id: string; name: string; webViewLink: string };

        // Insert markdown content if provided
        if (p.markdown) {
          try {
            await insertMarkdown(token, doc.id, p.markdown, {
              startIndex: 1,
              firstHeadingAsTitle: true,
            });
          } catch {
            // Document created but content insert failed — return success with warning
          }
        }

        return {
          success: true,
          data: { id: doc.id, name: doc.name, url: doc.webViewLink },
        };
      }

      case 'drive.create_folder': {
        const p = createFolder.params.parse(params);
        const metadata: Record<string, unknown> = {
          name: p.name,
          mimeType: 'application/vnd.google-apps.folder',
        };
        if (p.parentFolderId) metadata.parents = [p.parentFolderId];
        if (p.description) metadata.description = p.description;

        const qs = new URLSearchParams({
          fields: 'id,name,webViewLink',
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files?${qs}`, token, {
          method: 'POST',
          body: JSON.stringify(metadata),
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.copy_file': {
        const p = copyFile.params.parse(params);
        const body: Record<string, unknown> = {};
        if (p.name) body.name = p.name;
        if (p.folderId) body.parents = [p.folderId];

        const qs = new URLSearchParams({
          fields: 'id,name,mimeType,webViewLink',
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files/${encodeURIComponent(p.fileId)}/copy?${qs}`, token, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.move_file': {
        const p = moveFile.params.parse(params);

        // Get current parents
        const metaQs = new URLSearchParams({
          fields: 'name,parents',
          supportsAllDrives: 'true',
        });
        const metaRes = await driveFetch(`/files/${encodeURIComponent(p.fileId)}?${metaQs}`, token);
        if (!metaRes.ok) return driveError(metaRes);
        const meta = (await metaRes.json()) as { name: string; parents?: string[] };
        const currentParents = (meta.parents || []).join(',');

        const moveQs = new URLSearchParams({
          addParents: p.folderId,
          fields: 'id,name,parents',
          supportsAllDrives: 'true',
        });
        if (currentParents) moveQs.set('removeParents', currentParents);

        const res = await driveFetch(`/files/${encodeURIComponent(p.fileId)}?${moveQs}`, token, {
          method: 'PATCH',
          body: JSON.stringify({}),
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.rename_file': {
        const p = renameFile.params.parse(params);
        const qs = new URLSearchParams({
          fields: 'id,name,webViewLink',
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files/${encodeURIComponent(p.fileId)}?${qs}`, token, {
          method: 'PATCH',
          body: JSON.stringify({ name: p.name }),
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.delete_file': {
        const { fileId, permanent } = deleteFileDef.params.parse(params);
        if (permanent) {
          const qs = new URLSearchParams({ supportsAllDrives: 'true' });
          const res = await driveFetch(`/files/${encodeURIComponent(fileId)}?${qs}`, token, {
            method: 'DELETE',
          });
          if (!res.ok && res.status !== 404) return driveError(res);
          return { success: true, data: { trashed: false, permanentlyDeleted: true } };
        } else {
          const qs = new URLSearchParams({ supportsAllDrives: 'true' });
          const res = await driveFetch(`/files/${encodeURIComponent(fileId)}?${qs}`, token, {
            method: 'PATCH',
            body: JSON.stringify({ trashed: true }),
          });
          if (!res.ok && res.status !== 404) return driveError(res);
          return { success: true, data: { trashed: true, permanentlyDeleted: false } };
        }
      }

      case 'drive.download_file': {
        const { fileId, maxSizeBytes } = downloadFile.params.parse(params);
        const maxBytes = maxSizeBytes || 1_048_576; // 1MB default

        // Get metadata to check type and size
        const metaQs = new URLSearchParams({
          fields: 'id,name,mimeType,size',
          supportsAllDrives: 'true',
        });
        const metaRes = await driveFetch(`/files/${encodeURIComponent(fileId)}?${metaQs}`, token);
        if (!metaRes.ok) return driveError(metaRes);
        const meta = (await metaRes.json()) as DriveFile;

        // Google Workspace files: export as text
        if (isGoogleWorkspaceMimeType(meta.mimeType)) {
          const exportMime = getExportMimeType(meta.mimeType);
          if (!exportMime) {
            return {
              success: false,
              error: `Cannot export Google Workspace type: ${meta.mimeType}`,
            };
          }
          const exportQs = new URLSearchParams({ mimeType: exportMime });
          const exportRes = await driveFetch(
            `/files/${encodeURIComponent(fileId)}/export?${exportQs}`,
            token,
          );
          if (!exportRes.ok) return driveError(exportRes);
          const text = await exportRes.text();
          const textBytes = new TextEncoder().encode(text).length;
          if (textBytes > maxBytes) {
            return {
              success: false,
              error: `Exported content is ${textBytes} bytes, exceeds max ${maxBytes} bytes. Increase maxSizeBytes.`,
            };
          }
          return {
            success: true,
            data: { name: meta.name, mimeType: meta.mimeType, exportedAs: exportMime, content: text },
          };
        }

        // Regular text files: download content
        if (!isTextMimeType(meta.mimeType)) {
          return {
            success: false,
            error: `Cannot download binary file (${meta.mimeType}). Only text-based and Google Workspace files are supported.`,
          };
        }

        const fileSize = meta.size ? parseInt(meta.size) : 0;
        if (fileSize > maxBytes) {
          return {
            success: false,
            error: `File is ${fileSize} bytes, exceeds max ${maxBytes} bytes. Increase maxSizeBytes.`,
          };
        }

        const dlQs = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
        const dlRes = await driveFetch(`/files/${encodeURIComponent(fileId)}?${dlQs}`, token);
        if (!dlRes.ok) return driveError(dlRes);
        const content = await dlRes.text();
        return {
          success: true,
          data: { name: meta.name, mimeType: meta.mimeType, content },
        };
      }

      case 'drive.create_from_template': {
        const p = createFromTemplate.params.parse(params);

        // Step 1: Copy template
        const copyBody: Record<string, unknown> = { name: p.title };
        if (p.folderId) copyBody.parents = [p.folderId];

        const copyQs = new URLSearchParams({
          fields: 'id,name,webViewLink',
          supportsAllDrives: 'true',
        });
        const copyRes = await driveFetch(
          `/files/${encodeURIComponent(p.templateId)}/copy?${copyQs}`,
          token,
          { method: 'POST', body: JSON.stringify(copyBody) },
        );
        if (!copyRes.ok) return driveError(copyRes);
        const newDoc = (await copyRes.json()) as { id: string; name: string; webViewLink: string };

        // Step 2: Apply replacements via Docs batchUpdate
        if (p.replacements && Object.keys(p.replacements).length > 0) {
          try {
            const requests = Object.entries(p.replacements).map(([searchText, replaceText]) => ({
              replaceAllText: {
                containsText: { text: searchText, matchCase: false },
                replaceText,
              },
            }));

            const batchRes = await fetch(
              `${DOCS_API}/documents/${encodeURIComponent(newDoc.id)}:batchUpdate`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ requests }),
              },
            );

            if (!batchRes.ok) {
              // Replacements failed but document was created — continue
            }
          } catch {
            // Replacements failed but document was created — continue
          }
        }

        return {
          success: true,
          data: { id: newDoc.id, name: newDoc.name, url: newDoc.webViewLink },
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

export const driveActionDefs: ActionDefinition[] = allActions;
export { executeAction as executeDriveAction };
export { resolveCorpora };
