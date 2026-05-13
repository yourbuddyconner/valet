-- Dedup: for each (user_id, name) group with duplicates, keep the row with
-- the oldest created_at. Before deleting duplicates, copy the most recent
-- last_run_at to the survivor so we don't lose scheduling state.

-- Step 1: Copy latest last_run_at from duplicates to survivors
UPDATE triggers
SET last_run_at = (
  SELECT MAX(t2.last_run_at)
  FROM triggers t2
  WHERE t2.user_id = triggers.user_id
    AND t2.name = triggers.name COLLATE NOCASE
    AND t2.last_run_at IS NOT NULL
)
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY user_id, name COLLATE NOCASE ORDER BY created_at ASC
    ) AS rn
    FROM triggers
  ) WHERE rn = 1
)
AND EXISTS (
  SELECT 1 FROM triggers t2
  WHERE t2.user_id = triggers.user_id
    AND t2.name = triggers.name COLLATE NOCASE
    AND t2.id != triggers.id
);

-- Step 2: Delete duplicate rows (keep oldest per user_id + name, case-insensitive)
DELETE FROM triggers WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY user_id, name COLLATE NOCASE ORDER BY created_at ASC
    ) AS rn
    FROM triggers
  ) WHERE rn = 1
);

-- Step 3: Add uniqueness constraint (NOCASE for case-insensitive name matching)
CREATE UNIQUE INDEX idx_triggers_user_name ON triggers(user_id, name COLLATE NOCASE);
