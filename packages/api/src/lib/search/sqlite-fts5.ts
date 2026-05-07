import type { D1Database } from '@cloudflare/workers-types';
import type { SearchProvider } from './types.js';

/**
 * SQLite FTS5 implementation of SearchProvider.
 * Wraps the raw FTS5 queries previously in db/orchestrator.ts.
 */
export class SqliteFts5SearchProvider implements SearchProvider {
  constructor(private db: D1Database) {}

  async searchMemories(
    userId: string,
    query: string,
    opts?: { category?: string; limit?: number },
  ): Promise<Array<{ id: string; content: string; category: string; relevance: number }>> {
    const limit = opts?.limit || 50;

    const ftsQuery = query
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w}"`)
      .join(' OR ');

    if (!ftsQuery) {
      return this.listPlain(userId, opts?.category, limit);
    }

    let sql = `
      SELECT m.id, m.content, m.category, m.relevance
      FROM orchestrator_memories m
      JOIN orchestrator_memories_fts fts ON fts.rowid = m.rowid
      WHERE orchestrator_memories_fts MATCH ? AND m.user_id = ?`;
    const params: (string | number)[] = [ftsQuery, userId];

    if (opts?.category) {
      sql += ' AND m.category = ?';
      params.push(opts.category);
    }

    sql += ' ORDER BY bm25(orchestrator_memories_fts) LIMIT ?';
    params.push(limit);

    const result = await this.db.prepare(sql).bind(...params).all<{
      id: string;
      content: string;
      category: string;
      relevance: number;
    }>();

    return result.results || [];
  }

  async indexMemory(memory: {
    id: string;
    category: string;
    content: string;
    userId: string;
  }): Promise<void> {
    // Get the rowid of the memory row (must already be inserted into orchestrator_memories)
    const row = await this.db
      .prepare('SELECT rowid FROM orchestrator_memories WHERE id = ?')
      .bind(memory.id)
      .first<{ rowid: number }>();

    if (!row) return;

    // Use INSERT OR REPLACE to handle re-indexing after content updates
    await this.db
      .prepare('INSERT OR REPLACE INTO orchestrator_memories_fts(rowid, category, content) VALUES (?, ?, ?)')
      .bind(row.rowid, memory.category, memory.content)
      .run();
  }

  async removeMemory(id: string): Promise<void> {
    const row = await this.db
      .prepare('SELECT rowid FROM orchestrator_memories WHERE id = ?')
      .bind(id)
      .first<{ rowid: number }>();

    if (!row) return;

    // Delete main row first, then clean up FTS index
    await this.db
      .prepare('DELETE FROM orchestrator_memories WHERE id = ?')
      .bind(id)
      .run();
    await this.db
      .prepare('DELETE FROM orchestrator_memories_fts WHERE rowid = ?')
      .bind(row.rowid)
      .run();
  }

  private async listPlain(
    userId: string,
    category?: string,
    limit: number = 50,
  ): Promise<Array<{ id: string; content: string; category: string; relevance: number }>> {
    let sql = 'SELECT id, content, category, relevance FROM orchestrator_memories WHERE user_id = ?';
    const params: (string | number)[] = [userId];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }

    sql += ' ORDER BY relevance DESC, last_accessed_at DESC LIMIT ?';
    params.push(limit);

    const result = await this.db.prepare(sql).bind(...params).all<{
      id: string;
      content: string;
      category: string;
      relevance: number;
    }>();

    return result.results || [];
  }
}
