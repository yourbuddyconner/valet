-- Migration: Add title column to orchestrator_memory_files and rebuild FTS with 3-column layout

-- 1. Add title column
ALTER TABLE orchestrator_memory_files ADD COLUMN title TEXT NOT NULL DEFAULT '';

-- 2. Backfill title from content or path
--    If content starts with '# ' (H1 heading), extract heading text up to first newline.
--    Otherwise, use the last path segment with '.md' stripped.
-- Backfill title: H1 heading or last path segment (filename without .md)
WITH RECURSIVE strip(id, rest) AS (
  SELECT id, path FROM orchestrator_memory_files
  UNION ALL
  SELECT id, SUBSTR(rest, INSTR(rest, '/') + 1)
  FROM strip WHERE INSTR(rest, '/') > 0
),
last_segments AS (
  SELECT id,
    CASE WHEN rest LIKE '%.md'
      THEN SUBSTR(rest, 1, LENGTH(rest) - 3)
      ELSE rest
    END AS title
  FROM strip
  WHERE INSTR(rest, '/') = 0
)
UPDATE orchestrator_memory_files
SET title = CASE
  WHEN content LIKE '# %' THEN
    TRIM(SUBSTR(
      content, 3,
      CASE
        WHEN INSTR(SUBSTR(content, 3), CHAR(10)) > 0
          THEN INSTR(SUBSTR(content, 3), CHAR(10)) - 1
        ELSE LENGTH(content)
      END
    ))
  ELSE (SELECT ls.title FROM last_segments ls WHERE ls.id = orchestrator_memory_files.id)
END
WHERE title = '';

-- 3. Drop the existing FTS virtual table
DROP TABLE IF EXISTS orchestrator_memory_files_fts;

-- 4. Recreate FTS5 index with 3 columns: path, title, content
CREATE VIRTUAL TABLE orchestrator_memory_files_fts USING fts5(
  path,
  title,
  content,
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- 5. Repopulate FTS from base table
INSERT INTO orchestrator_memory_files_fts(rowid, path, title, content)
  SELECT rowid, path, title, content FROM orchestrator_memory_files;
