import { Hono } from 'hono';
import { NotFoundError, ValidationError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';

export const filesRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Helper to proxy a request to the SessionAgentDO's /proxy/ endpoint.
 */
async function proxyToSession(env: Env, sessionId: string, path: string): Promise<Response> {
  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);
  return sessionDO.fetch(new Request(`http://do/proxy/${path}`));
}

/**
 * GET /api/files/find
 * Fuzzy find files by name in a session's workspace via OpenCode
 */
filesRouter.get('/find', async (c) => {
  const user = c.get('user');
  const { sessionId, query, limit } = c.req.query();

  if (!sessionId) {
    throw new ValidationError('sessionId is required');
  }

  if (!query) {
    throw new ValidationError('query is required');
  }

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const params = new URLSearchParams({ query });
  if (limit) params.set('limit', limit);

  const response = await proxyToSession(c.env, sessionId, `find/file?${params}`);

  if (!response.ok) {
    return c.json({ paths: [] });
  }

  // OpenCode returns a plain string array; wrap it for the frontend
  const paths = await response.json() as string[];
  return c.json({ paths });
});

/**
 * GET /api/files/search
 * Search file contents in a session's workspace via OpenCode
 * OpenCode endpoint: GET /find?pattern=X (returns ripgrep-style matches)
 */
filesRouter.get('/search', async (c) => {
  const user = c.get('user');
  const { sessionId, query, limit } = c.req.query();

  if (!sessionId) {
    throw new ValidationError('sessionId is required');
  }

  if (!query) {
    throw new ValidationError('query is required');
  }

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const params = new URLSearchParams({ pattern: query });
  if (limit) params.set('limit', limit);

  const response = await proxyToSession(c.env, sessionId, `find?${params}`);

  if (!response.ok) {
    return c.json({ results: [] });
  }

  // OpenCode returns ripgrep-style matches; transform to frontend format
  const matches = await response.json() as Array<{
    path: { text: string };
    lines: { text: string };
    line_number: number;
  }>;
  const results = matches.map((m) => ({
    path: m.path.text,
    line: m.line_number,
    content: m.lines.text,
  }));
  return c.json({ results });
});

/**
 * GET /api/files/read
 * Read a file from a session's workspace
 */
filesRouter.get('/read', async (c) => {
  const user = c.get('user');
  const { sessionId, path } = c.req.query();

  if (!sessionId) {
    throw new ValidationError('sessionId is required');
  }

  if (!path) {
    throw new ValidationError('path is required');
  }

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  // OpenCode endpoint: GET /file/content?path=X → { type: "text", content: "..." }
  const response = await proxyToSession(
    c.env,
    sessionId,
    `file/content?path=${encodeURIComponent(path)}`,
  );

  if (!response.ok) {
    throw new NotFoundError('File', path);
  }

  const data = await response.json() as { type: string; content: string };
  return c.json({ content: data.content, path });
});

/**
 * GET /api/files/list
 * List files in a directory
 */
filesRouter.get('/list', async (c) => {
  const user = c.get('user');
  const { sessionId, path } = c.req.query();

  if (!sessionId) {
    throw new ValidationError('sessionId is required');
  }

  const dirPath = path || '/';

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  // OpenCode endpoint: GET /file?path=X → Array<FileNode>
  const response = await proxyToSession(
    c.env,
    sessionId,
    `file?path=${encodeURIComponent(dirPath)}`,
  );

  if (!response.ok) {
    return c.json({ files: [] });
  }

  // OpenCode returns Array<{ name, path, absolute, type, ignored }>; transform to frontend format
  const nodes = await response.json() as Array<{
    name: string;
    path: string;
    absolute: string;
    type: 'file' | 'directory';
    ignored: boolean;
  }>;
  const files = nodes
    .filter((n) => !n.ignored)
    .map((n) => ({
      name: n.name,
      path: n.path,
      type: n.type,
    }));
  return c.json({ files });
});

/**
 * GET /api/files/backup
 * List backed up files in R2 for a session
 */
filesRouter.get('/backup', async (c) => {
  const user = c.get('user');
  const { sessionId, prefix } = c.req.query();

  if (!sessionId) {
    throw new ValidationError('sessionId is required');
  }

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const r2Prefix = `backups/${user.id}/sessions/${sessionId}/artifacts/${prefix || ''}`;
  const objects = await c.env.STORAGE.list({ prefix: r2Prefix, limit: 100 });

  const files = objects.objects.map((obj) => ({
    key: obj.key.replace(r2Prefix, ''),
    size: obj.size,
    uploaded: obj.uploaded,
  }));

  return c.json({ files });
});

/**
 * GET /api/files/backup/:key
 * Download a backed up file from R2
 */
filesRouter.get('/backup/:key', async (c) => {
  const user = c.get('user');
  const { sessionId } = c.req.query();
  const { key } = c.req.param();

  if (!sessionId) {
    throw new ValidationError('sessionId is required');
  }

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const r2Key = `backups/${user.id}/sessions/${sessionId}/artifacts/${key}`;
  const object = await c.env.STORAGE.get(r2Key);

  if (!object) {
    throw new NotFoundError('File', key);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Disposition', `attachment; filename="${key}"`);

  return new Response(object.body, { headers });
});

/**
 * POST /api/files/backup
 * Backup a file to R2
 */
filesRouter.post('/backup', async (c) => {
  const user = c.get('user');
  const { sessionId, path, content } = await c.req.json<{
    sessionId: string;
    path: string;
    content: string;
  }>();

  if (!sessionId || !path || !content) {
    throw new ValidationError('sessionId, path, and content are required');
  }

  const session = await db.getSession(c.get('db'), sessionId);
  if (!session || session.userId !== user.id) {
    throw new NotFoundError('Session', sessionId);
  }

  const timestamp = Date.now();
  const filename = path.split('/').pop() || 'file';
  const r2Key = `backups/${user.id}/sessions/${sessionId}/artifacts/${timestamp}_${filename}`;

  await c.env.STORAGE.put(r2Key, content, {
    httpMetadata: {
      contentType: 'application/octet-stream',
    },
    customMetadata: {
      originalPath: path,
      sessionId,
    },
  });

  return c.json({ key: `${timestamp}_${filename}`, success: true });
});
