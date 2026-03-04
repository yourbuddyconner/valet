import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import {
  driveFetch,
  driveUploadFetch,
  buildMultipartBody,
  isGoogleWorkspaceMimeType,
  isTextMimeType,
  getExportMimeType,
} from './api.js';

/** Escape a string value for use inside a Drive API query `q` parameter. */
function escapeDriveQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Build a descriptive error from a failed Drive API response. */
async function driveError(res: Response): Promise<ActionResult> {
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

// ─── Internal Types ──────────────────────────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  description?: string;
  starred?: boolean;
  trashed?: boolean;
  parents?: string[];
  webViewLink?: string;
  webContentLink?: string;
  iconLink?: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: Array<{ displayName: string; emailAddress: string }>;
  lastModifyingUser?: { displayName: string; emailAddress: string };
  shared?: boolean;
  capabilities?: Record<string, boolean>;
}

interface DrivePermission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
}

const FILE_FIELDS =
  'id,name,mimeType,description,starred,trashed,parents,webViewLink,webContentLink,iconLink,size,createdTime,modifiedTime,owners,lastModifyingUser,shared';

// ─── Action Definitions ──────────────────────────────────────────────────────

// File Discovery

const listFiles: ActionDefinition = {
  id: 'drive.list_files',
  name: 'List Files',
  description: 'List files with optional folder, query, and MIME type filtering',
  riskLevel: 'low',
  params: z.object({
    folderId: z.string().optional().describe('Folder ID to list contents of (default: root)'),
    query: z.string().optional().describe('Additional Drive query filter (appended to folder filter)'),
    mimeType: z.string().optional().describe('Filter by MIME type'),
    maxResults: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
    orderBy: z.string().optional().describe('Sort order, e.g. "modifiedTime desc"'),
    includeTrash: z.boolean().optional().describe('Include trashed files (default: false)'),
  }),
};

const searchFiles: ActionDefinition = {
  id: 'drive.search_files',
  name: 'Search Files',
  description: 'Full-text search across file names and content',
  riskLevel: 'low',
  params: z.object({
    query: z.string().describe('Search text (matches file names and content)'),
    maxResults: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
  }),
};

const getFile: ActionDefinition = {
  id: 'drive.get_file',
  name: 'Get File',
  description: 'Get file metadata by ID',
  riskLevel: 'low',
  params: z.object({
    fileId: z.string(),
  }),
};

const readFile: ActionDefinition = {
  id: 'drive.read_file',
  name: 'Read File',
  description:
    'Download and return text content of a file. Auto-exports Google Workspace files (Docs→text, Sheets→CSV). Extracts text from PDFs. Rejects other binary files.',
  riskLevel: 'low',
  params: z.object({
    fileId: z.string(),
    maxSizeBytes: z.number().int().optional().describe('Max bytes to read (default: 1MB)'),
  }),
};

const EXPORTABLE_TEXT_MIME_TYPES = [
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'text/html',
  'application/json',
  'application/xml',
  'application/vnd.google-apps.script+json',
] as const;

const exportFile: ActionDefinition = {
  id: 'drive.export_file',
  name: 'Export File',
  description:
    'Export a Google Workspace file (Docs, Sheets, Slides) to a text-based format. Only text formats are supported.',
  riskLevel: 'low',
  params: z.object({
    fileId: z.string(),
    mimeType: z
      .enum(EXPORTABLE_TEXT_MIME_TYPES)
      .describe(
        'Target text MIME type, e.g. "text/plain", "text/csv", "text/html"',
      ),
  }),
};

// File Management

const createFile: ActionDefinition = {
  id: 'drive.create_file',
  name: 'Create File',
  description: 'Create a new file with text content',
  riskLevel: 'medium',
  params: z.object({
    name: z.string(),
    content: z.string().describe('Text content of the file'),
    mimeType: z.string().optional().describe('MIME type (default: text/plain)'),
    folderId: z.string().optional().describe('Parent folder ID'),
    description: z.string().optional(),
  }),
};

const createFolder: ActionDefinition = {
  id: 'drive.create_folder',
  name: 'Create Folder',
  description: 'Create a new folder',
  riskLevel: 'medium',
  params: z.object({
    name: z.string(),
    parentFolderId: z.string().optional().describe('Parent folder ID'),
    description: z.string().optional(),
  }),
};

const updateMetadata: ActionDefinition = {
  id: 'drive.update_metadata',
  name: 'Update Metadata',
  description: 'Rename, move, or update description of a file or folder',
  riskLevel: 'medium',
  params: z.object({
    fileId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    addParents: z.string().optional().describe('Comma-separated folder IDs to add'),
    removeParents: z.string().optional().describe('Comma-separated folder IDs to remove'),
    starred: z.boolean().optional(),
  }),
};

const updateContent: ActionDefinition = {
  id: 'drive.update_content',
  name: 'Update Content',
  description: 'Replace the content of an existing file',
  riskLevel: 'medium',
  params: z.object({
    fileId: z.string(),
    content: z.string().describe('New text content'),
    mimeType: z.string().optional().describe('MIME type (default: preserves existing)'),
  }),
};

const copyFile: ActionDefinition = {
  id: 'drive.copy_file',
  name: 'Copy File',
  description: 'Copy a file, optionally to a different folder with a new name',
  riskLevel: 'medium',
  params: z.object({
    fileId: z.string(),
    name: z.string().optional().describe('Name for the copy'),
    folderId: z.string().optional().describe('Destination folder ID'),
  }),
};

// Sharing

const shareFile: ActionDefinition = {
  id: 'drive.share_file',
  name: 'Share File',
  description: 'Share a file or folder with a user, group, domain, or anyone',
  riskLevel: 'high',
  params: z.object({
    fileId: z.string(),
    role: z.enum(['reader', 'commenter', 'writer', 'organizer']),
    type: z.enum(['user', 'group', 'domain', 'anyone']),
    emailAddress: z.string().optional().describe('Required for user/group type'),
    domain: z.string().optional().describe('Required for domain type'),
    sendNotificationEmail: z.boolean().optional().describe('Send email notification (default: true)'),
    emailMessage: z.string().optional().describe('Custom message in the notification email'),
  }),
};

const listPermissions: ActionDefinition = {
  id: 'drive.list_permissions',
  name: 'List Permissions',
  description: 'List all permissions on a file or folder',
  riskLevel: 'low',
  params: z.object({
    fileId: z.string(),
  }),
};

const removePermission: ActionDefinition = {
  id: 'drive.remove_permission',
  name: 'Remove Permission',
  description: 'Remove a permission from a file or folder',
  riskLevel: 'high',
  params: z.object({
    fileId: z.string(),
    permissionId: z.string(),
  }),
};

// Cleanup

const trashFile: ActionDefinition = {
  id: 'drive.trash_file',
  name: 'Trash File',
  description: 'Move a file or folder to trash (recoverable)',
  riskLevel: 'high',
  params: z.object({
    fileId: z.string(),
  }),
};

const untrashFile: ActionDefinition = {
  id: 'drive.untrash_file',
  name: 'Untrash File',
  description: 'Restore a file or folder from trash',
  riskLevel: 'medium',
  params: z.object({
    fileId: z.string(),
  }),
};

const deleteFile: ActionDefinition = {
  id: 'drive.delete_file',
  name: 'Delete File',
  description: 'Permanently delete a file or folder (cannot be undone)',
  riskLevel: 'critical',
  params: z.object({
    fileId: z.string(),
  }),
};

const allActions: ActionDefinition[] = [
  listFiles,
  searchFiles,
  getFile,
  readFile,
  exportFile,
  createFile,
  createFolder,
  updateMetadata,
  updateContent,
  copyFile,
  shareFile,
  listPermissions,
  removePermission,
  trashFile,
  untrashFile,
  deleteFile,
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
      // ── File Discovery ──

      case 'drive.list_files': {
        const p = listFiles.params.parse(params);
        const queryParts: string[] = [];
        if (p.folderId) queryParts.push(`'${escapeDriveQuery(p.folderId)}' in parents`);
        if (p.mimeType) queryParts.push(`mimeType = '${escapeDriveQuery(p.mimeType)}'`);
        if (!p.includeTrash) queryParts.push('trashed = false');
        if (p.query) queryParts.push(p.query);

        const qs = new URLSearchParams({
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: String(p.maxResults || 20),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        if (queryParts.length) qs.set('q', queryParts.join(' and '));
        if (p.pageToken) qs.set('pageToken', p.pageToken);
        if (p.orderBy) qs.set('orderBy', p.orderBy);

        const res = await driveFetch(`/files?${qs}`, token);
        if (!res.ok) return driveError(res);
        const data = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
        return { success: true, data: { files: data.files || [], nextPageToken: data.nextPageToken } };
      }

      case 'drive.search_files': {
        const p = searchFiles.params.parse(params);
        const qs = new URLSearchParams({
          q: `fullText contains '${escapeDriveQuery(p.query)}' and trashed = false`,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: String(p.maxResults || 20),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        if (p.pageToken) qs.set('pageToken', p.pageToken);

        const res = await driveFetch(`/files?${qs}`, token);
        if (!res.ok) return driveError(res);
        const data = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
        return { success: true, data: { files: data.files || [], nextPageToken: data.nextPageToken } };
      }

      case 'drive.get_file': {
        const { fileId } = getFile.params.parse(params);
        const qs = new URLSearchParams({
          fields: FILE_FIELDS,
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files/${encodeURIComponent(fileId)}?${qs}`, token);
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.read_file': {
        const { fileId, maxSizeBytes } = readFile.params.parse(params);
        const maxBytes = maxSizeBytes || 1_048_576; // 1MB default

        // Get metadata first to check type and size
        const metaQs = new URLSearchParams({
          fields: 'id,name,mimeType,size',
          supportsAllDrives: 'true',
        });
        const metaRes = await driveFetch(`/files/${encodeURIComponent(fileId)}?${metaQs}`, token);
        if (!metaRes.ok) return driveError(metaRes);
        const meta = (await metaRes.json()) as DriveFile;

        // Google Workspace files — export as text
        if (isGoogleWorkspaceMimeType(meta.mimeType)) {
          const exportMime = getExportMimeType(meta.mimeType);
          if (!exportMime) {
            return {
              success: false,
              error: `Cannot read Google Workspace type: ${meta.mimeType}. Use drive.export_file with a specific target format.`,
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
              error: `Exported content is ${textBytes} bytes, exceeds max ${maxBytes} bytes. Increase maxSizeBytes or use drive.export_file directly.`,
            };
          }
          return {
            success: true,
            data: {
              name: meta.name,
              mimeType: meta.mimeType,
              exportedAs: exportMime,
              content: text,
            },
          };
        }

        // PDF files — extract text
        if (meta.mimeType === 'application/pdf') {
          const pdfMaxBytes = maxSizeBytes || 5_242_880; // 5MB default for PDFs
          const pdfSize = meta.size ? parseInt(meta.size) : 0;
          if (pdfSize > pdfMaxBytes) {
            return {
              success: false,
              error: `PDF is ${pdfSize} bytes, exceeds max ${pdfMaxBytes} bytes. Increase maxSizeBytes or download externally.`,
            };
          }

          const pdfDlQs = new URLSearchParams({
            alt: 'media',
            supportsAllDrives: 'true',
          });
          const pdfRes = await driveFetch(`/files/${encodeURIComponent(fileId)}?${pdfDlQs}`, token);
          if (!pdfRes.ok) return driveError(pdfRes);

          const pdfBuffer = new Uint8Array(await pdfRes.arrayBuffer());
          const { getDocumentProxy, extractText } = await import('unpdf');
          const doc = await getDocumentProxy(pdfBuffer);
          const { text, totalPages } = await extractText(doc);

          return {
            success: true,
            data: { name: meta.name, mimeType: meta.mimeType, content: text, pageCount: totalPages },
          };
        }

        // Regular files — check if text-based
        if (!isTextMimeType(meta.mimeType)) {
          return {
            success: false,
            error: `Cannot read binary file (${meta.mimeType}). Use drive.get_file for metadata or drive.export_file for Google Workspace files.`,
          };
        }

        // Check size
        const fileSize = meta.size ? parseInt(meta.size) : 0;
        if (fileSize > maxBytes) {
          return {
            success: false,
            error: `File is ${fileSize} bytes, exceeds max ${maxBytes} bytes. Increase maxSizeBytes or download externally.`,
          };
        }

        const dlQs = new URLSearchParams({
          alt: 'media',
          supportsAllDrives: 'true',
        });
        const dlRes = await driveFetch(`/files/${encodeURIComponent(fileId)}?${dlQs}`, token);
        if (!dlRes.ok) return driveError(dlRes);
        const content = await dlRes.text();
        return {
          success: true,
          data: { name: meta.name, mimeType: meta.mimeType, content },
        };
      }

      case 'drive.export_file': {
        const { fileId, mimeType } = exportFile.params.parse(params);
        const qs = new URLSearchParams({ mimeType });
        const res = await driveFetch(`/files/${encodeURIComponent(fileId)}/export?${qs}`, token);
        if (!res.ok) return driveError(res);
        const content = await res.text();
        const MAX_EXPORT_BYTES = 10 * 1024 * 1024; // 10MB
        const contentBytes = new TextEncoder().encode(content).length;
        if (contentBytes > MAX_EXPORT_BYTES) {
          return {
            success: false,
            error: `Export is ${contentBytes} bytes, exceeds maximum of ${MAX_EXPORT_BYTES} bytes (10MB).`,
          };
        }
        return { success: true, data: { content, exportedAs: mimeType } };
      }

      // ── File Management ──

      case 'drive.create_file': {
        const p = createFile.params.parse(params);
        const contentType = p.mimeType || 'text/plain';
        const metadata: Record<string, unknown> = { name: p.name };
        if (p.folderId) metadata.parents = [p.folderId];
        if (p.description) metadata.description = p.description;

        const { body, boundary } = buildMultipartBody(metadata, p.content, contentType);
        const qs = new URLSearchParams({
          uploadType: 'multipart',
          fields: FILE_FIELDS,
          supportsAllDrives: 'true',
        });
        const res = await driveUploadFetch(`/files?${qs}`, token, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
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
          fields: FILE_FIELDS,
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files?${qs}`, token, {
          method: 'POST',
          body: JSON.stringify(metadata),
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.update_metadata': {
        const p = updateMetadata.params.parse(params);
        const body: Record<string, unknown> = {};
        if (p.name !== undefined) body.name = p.name;
        if (p.description !== undefined) body.description = p.description;
        if (p.starred !== undefined) body.starred = p.starred;

        const qs = new URLSearchParams({
          fields: FILE_FIELDS,
          supportsAllDrives: 'true',
        });
        if (p.addParents) qs.set('addParents', p.addParents);
        if (p.removeParents) qs.set('removeParents', p.removeParents);

        const res = await driveFetch(`/files/${encodeURIComponent(p.fileId)}?${qs}`, token, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.update_content': {
        const p = updateContent.params.parse(params);
        let contentType = p.mimeType;
        if (!contentType) {
          const metaRes = await driveFetch(
            `/files/${encodeURIComponent(p.fileId)}?fields=mimeType&supportsAllDrives=true`,
            token,
          );
          const existingMeta = metaRes.ok ? ((await metaRes.json()) as { mimeType: string }) : null;
          contentType = existingMeta?.mimeType || 'text/plain';
        }
        const qs = new URLSearchParams({
          uploadType: 'media',
          fields: FILE_FIELDS,
          supportsAllDrives: 'true',
        });
        const res = await driveUploadFetch(
          `/files/${encodeURIComponent(p.fileId)}?${qs}`,
          token,
          {
            method: 'PATCH',
            headers: { 'Content-Type': contentType },
            body: p.content,
          },
        );
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.copy_file': {
        const p = copyFile.params.parse(params);
        const body: Record<string, unknown> = {};
        if (p.name) body.name = p.name;
        if (p.folderId) body.parents = [p.folderId];

        const qs = new URLSearchParams({
          fields: FILE_FIELDS,
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files/${encodeURIComponent(p.fileId)}/copy?${qs}`, token, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      // ── Sharing ──

      case 'drive.share_file': {
        const p = shareFile.params.parse(params);
        const body: Record<string, unknown> = { role: p.role, type: p.type };
        if (p.emailAddress) body.emailAddress = p.emailAddress;
        if (p.domain) body.domain = p.domain;

        const qs = new URLSearchParams({ supportsAllDrives: 'true' });
        if (p.sendNotificationEmail !== undefined) {
          qs.set('sendNotificationEmail', String(p.sendNotificationEmail));
        }
        if (p.emailMessage) qs.set('emailMessage', p.emailMessage);

        const res = await driveFetch(
          `/files/${encodeURIComponent(p.fileId)}/permissions?${qs}`,
          token,
          { method: 'POST', body: JSON.stringify(body) },
        );
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.list_permissions': {
        const { fileId } = listPermissions.params.parse(params);
        const qs = new URLSearchParams({
          fields: 'permissions(id,type,role,emailAddress,domain,displayName)',
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(
          `/files/${encodeURIComponent(fileId)}/permissions?${qs}`,
          token,
        );
        if (!res.ok) return driveError(res);
        const data = (await res.json()) as { permissions: DrivePermission[] };
        return { success: true, data: data.permissions || [] };
      }

      case 'drive.remove_permission': {
        const { fileId, permissionId } = removePermission.params.parse(params);
        const qs = new URLSearchParams({ supportsAllDrives: 'true' });
        const res = await driveFetch(
          `/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?${qs}`,
          token,
          { method: 'DELETE' },
        );
        if (!res.ok && res.status !== 404) return driveError(res);
        return { success: true };
      }

      // ── Cleanup ──

      case 'drive.trash_file': {
        const { fileId } = trashFile.params.parse(params);
        const qs = new URLSearchParams({
          fields: FILE_FIELDS,
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files/${encodeURIComponent(fileId)}?${qs}`, token, {
          method: 'PATCH',
          body: JSON.stringify({ trashed: true }),
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.untrash_file': {
        const { fileId } = untrashFile.params.parse(params);
        const qs = new URLSearchParams({
          fields: FILE_FIELDS,
          supportsAllDrives: 'true',
        });
        const res = await driveFetch(`/files/${encodeURIComponent(fileId)}?${qs}`, token, {
          method: 'PATCH',
          body: JSON.stringify({ trashed: false }),
        });
        if (!res.ok) return driveError(res);
        return { success: true, data: await res.json() };
      }

      case 'drive.delete_file': {
        const { fileId } = deleteFile.params.parse(params);
        const qs = new URLSearchParams({ supportsAllDrives: 'true' });
        const res = await driveFetch(`/files/${encodeURIComponent(fileId)}?${qs}`, token, {
          method: 'DELETE',
        });
        if (!res.ok && res.status !== 404) return driveError(res);
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const googleDriveActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
