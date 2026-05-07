/**
 * Abstract search provider for memory indexing and retrieval.
 * Decouples the orchestrator from SQLite FTS5 specifics.
 */
export interface SearchProvider {
  searchMemories(
    userId: string,
    query: string,
    opts?: { category?: string; limit?: number },
  ): Promise<Array<{ id: string; content: string; category: string; relevance: number }>>;

  indexMemory(memory: {
    id: string;
    category: string;
    content: string;
    userId: string;
  }): Promise<void>;

  removeMemory(id: string): Promise<void>;
}
