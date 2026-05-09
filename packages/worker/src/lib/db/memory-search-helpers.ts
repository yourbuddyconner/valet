/**
 * Extract a human-readable title from memory file content.
 * Prefers the first # H1 heading; falls back to the filename (last path segment, no .md).
 */
export function extractTitle(content: string, path: string): string {
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const filename = path.split('/').pop() ?? path;
  return filename.replace(/\.md$/, '');
}

/**
 * Build a well-formed FTS5 MATCH query from a raw search string.
 *
 * - Quoted phrases ("exact phrase") → exact FTS5 phrase match, no prefix wildcard
 * - Plain terms → prefix wildcard match ("term"*)
 * - Terms prefixed with - → negation (NOT)
 * - Multiple positive terms → ANDed together
 * - Single-character terms and empty tokens are skipped
 *
 * Returns empty string if no valid terms remain.
 */
export function buildFTS5Query(raw: string): string {
  const terms: string[] = [];
  const notTerms: string[] = [];

  const tokens = raw.match(/"[^"]*"|-?\S+/g) ?? [];

  for (const token of tokens) {
    const isNegation = token.startsWith('-') && token.length > 1;
    const clean = isNegation ? token.slice(1) : token;

    if (clean.startsWith('"') && clean.endsWith('"') && clean.length > 2) {
      const phrase = clean.slice(1, -1).replace(/[^\w\s]/g, '').trim();
      if (!phrase) continue;
      (isNegation ? notTerms : terms).push(`"${phrase}"`);
    } else {
      // Split on non-word chars (hyphens, dots, etc.) to match FTS5 unicode61 tokenization
      const subTokens = clean.split(/[^\w]+/).map(s => s.toLowerCase()).filter(s => s.length >= 2);
      if (subTokens.length === 0) continue;
      for (const sub of subTokens) {
        (isNegation ? notTerms : terms).push(`"${sub}"*`);
      }
    }
  }

  if (terms.length === 0) return '';

  let query = terms.join(' AND ');
  if (notTerms.length > 0) {
    query += notTerms.length === 1
      ? ' NOT ' + notTerms[0]
      : ' NOT (' + notTerms.join(' OR ') + ')';
  }
  return query;
}

/**
 * Normalize FTS5's negative BM25 score to [0, 1).
 * FTS5 returns negative values: more negative = better match.
 * Formula: |x| / (1 + |x|)
 * Examples: -10 → 0.909, -2 → 0.667, -0.5 → 0.333, 0 → 0
 */
export function normalizeBM25(raw: number): number {
  const abs = Math.abs(raw);
  return abs / (1 + abs);
}

/**
 * Extract a match-aware snippet from document content.
 * Scores each line by how many query terms it contains, picks the best line,
 * and returns it with contextLines of surrounding context.
 * Prefixes with "[...]" if the match is more than 3 lines into the file.
 */
export function extractSnippet(
  content: string,
  queryTerms: string[],
  contextLines = 2,
): string {
  const lines = content.split('\n');
  let bestIdx = 0;
  let bestScore = -1;

  // Clean terms: strip FTS5 syntax characters for plain string matching
  const cleanTerms = queryTerms.map(t => t.replace(/[*"]/g, '').toLowerCase()).filter(t => t.length >= 2);

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let score = 0;
    for (const term of cleanTerms) {
      if (lower.includes(term)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const start = Math.max(0, bestIdx - contextLines);
  const end = Math.min(lines.length, bestIdx + contextLines + 1);
  const snippet = lines.slice(start, end).join('\n').trim();

  return start > 3 ? `[...]\n${snippet}` : snippet;
}

/**
 * Return a score bonus (0.2) if any query term appears in the file path.
 * Terms shorter than 2 chars are ignored. Matching is case-insensitive.
 */
export function pathBoost(path: string, queryTerms: string[]): number {
  const lp = path.toLowerCase();
  const cleaned = queryTerms.map(t => t.replace(/[*"]/g, '').toLowerCase());
  return cleaned.some(t => t.length >= 2 && lp.includes(t)) ? 0.2 : 0;
}
