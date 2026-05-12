-- Migrate orchestrator sessions to stable IDs (orchestrator:{userId})
-- For each user with an orchestrator identity, find their newest orchestrator session
-- and create/update a stable-ID row. Old rotated sessions are archived.

-- Step 1: Create stable session rows from existing orchestrator sessions.
-- Uses INSERT OR IGNORE so this migration is idempotent.
INSERT OR IGNORE INTO sessions (id, user_id, workspace, title, status, purpose, is_orchestrator, created_at, last_active_at)
SELECT
  'orchestrator:' || oi.user_id,
  oi.user_id,
  COALESCE(s.workspace, 'orchestrator'),
  COALESCE(s.title, oi.name || ' (Orchestrator)'),
  COALESCE(s.status, 'terminated'),
  'orchestrator',
  1,
  COALESCE(s.created_at, datetime('now')),
  datetime('now')
FROM orchestrator_identities oi
LEFT JOIN sessions s ON s.id = (
  SELECT s2.id FROM sessions s2
  WHERE s2.user_id = oi.user_id
    AND s2.is_orchestrator = 1
    AND s2.status != 'archived'
  ORDER BY s2.created_at DESC
  LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM sessions WHERE id = 'orchestrator:' || oi.user_id
);

-- Step 2: Migrate channel_bindings to stable IDs
UPDATE channel_bindings
SET session_id = 'orchestrator:' || user_id
WHERE session_id != 'orchestrator:' || user_id
  AND session_id IN (
    SELECT id FROM sessions WHERE is_orchestrator = 1
  );

-- Step 3: Migrate channel_thread_mappings to stable IDs
UPDATE channel_thread_mappings
SET session_id = 'orchestrator:' || user_id
WHERE session_id != 'orchestrator:' || user_id
  AND session_id IN (
    SELECT id FROM sessions WHERE is_orchestrator = 1
  );

-- Step 4: Migrate session_threads to stable IDs
UPDATE session_threads
SET session_id = 'orchestrator:' || (
  SELECT user_id FROM sessions WHERE sessions.id = session_threads.session_id
)
WHERE session_id IN (
  SELECT id FROM sessions WHERE is_orchestrator = 1
  AND id != 'orchestrator:' || user_id
);

-- Step 5: Archive old rotated orchestrator sessions
UPDATE sessions
SET status = 'archived', last_active_at = datetime('now')
WHERE is_orchestrator = 1
  AND id != 'orchestrator:' || user_id
  AND status != 'archived';
