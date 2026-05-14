-- Dedup: for each (org_id, name) group with duplicates, keep the row with
-- the newest created_at (most up-to-date content). Before deleting duplicates,
-- reassign any foreign key references (persona_id on orchestrator_identities,
-- sessions, and org_repo_persona_defaults) to the survivor.

-- Step 1: Reassign orchestrator_identities.persona_id from duplicates to survivors
UPDATE orchestrator_identities
SET persona_id = (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
    ) AS rn
    FROM agent_personas
  ) survivor
  WHERE survivor.rn = 1
    AND survivor.id != orchestrator_identities.persona_id
    AND EXISTS (
      SELECT 1 FROM agent_personas dup
      WHERE dup.id = orchestrator_identities.persona_id
        AND dup.org_id = (SELECT org_id FROM agent_personas WHERE id = survivor.id)
        AND dup.name COLLATE NOCASE = (SELECT name FROM agent_personas WHERE id = survivor.id) COLLATE NOCASE
    )
)
WHERE persona_id IS NOT NULL
  AND persona_id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
      ) AS rn
      FROM agent_personas
    ) WHERE rn = 1
  );

-- Step 2: Reassign sessions.persona_id from duplicates to survivors
UPDATE sessions
SET persona_id = (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
    ) AS rn
    FROM agent_personas
  ) survivor
  WHERE survivor.rn = 1
    AND survivor.id != sessions.persona_id
    AND EXISTS (
      SELECT 1 FROM agent_personas dup
      WHERE dup.id = sessions.persona_id
        AND dup.org_id = (SELECT org_id FROM agent_personas WHERE id = survivor.id)
        AND dup.name COLLATE NOCASE = (SELECT name FROM agent_personas WHERE id = survivor.id) COLLATE NOCASE
    )
)
WHERE persona_id IS NOT NULL
  AND persona_id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
      ) AS rn
      FROM agent_personas
    ) WHERE rn = 1
  );

-- Step 3: Reassign org_repo_persona_defaults.persona_id from duplicates to survivors
UPDATE org_repo_persona_defaults
SET persona_id = (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
    ) AS rn
    FROM agent_personas
  ) survivor
  WHERE survivor.rn = 1
    AND survivor.id != org_repo_persona_defaults.persona_id
    AND EXISTS (
      SELECT 1 FROM agent_personas dup
      WHERE dup.id = org_repo_persona_defaults.persona_id
        AND dup.org_id = (SELECT org_id FROM agent_personas WHERE id = survivor.id)
        AND dup.name COLLATE NOCASE = (SELECT name FROM agent_personas WHERE id = survivor.id) COLLATE NOCASE
    )
)
WHERE persona_id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
    ) AS rn
    FROM agent_personas
  ) WHERE rn = 1
);

-- Step 4: Delete duplicate persona files from duplicates that would conflict
-- with files the survivor already has (same filename). Keep the survivor's version.
DELETE FROM agent_persona_files
WHERE id IN (
  SELECT dpf.id
  FROM agent_persona_files dpf
  -- dpf belongs to a duplicate persona (not a survivor)
  JOIN (
    SELECT id as dup_id, org_id, name
    FROM agent_personas
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
        ) AS rn
        FROM agent_personas
      ) WHERE rn = 1
    )
  ) dup ON dup.dup_id = dpf.persona_id
  -- the survivor already has a file with the same filename
  JOIN (
    SELECT id as survivor_id, org_id, name
    FROM agent_personas
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
        ) AS rn
        FROM agent_personas
      ) WHERE rn = 1
    )
  ) surv ON surv.org_id = dup.org_id AND surv.name COLLATE NOCASE = dup.name COLLATE NOCASE
  JOIN agent_persona_files spf ON spf.persona_id = surv.survivor_id AND spf.filename = dpf.filename
);

-- Step 5: Move remaining persona files from duplicates to survivors (no conflicts now)
UPDATE agent_persona_files
SET persona_id = (
  SELECT survivor_id FROM (
    SELECT s.id as survivor_id, dup.id as dup_id
    FROM agent_personas s
    JOIN agent_personas dup ON dup.org_id = s.org_id
      AND dup.name COLLATE NOCASE = s.name COLLATE NOCASE
      AND dup.id != s.id
    WHERE s.id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
        ) AS rn
        FROM agent_personas
      ) WHERE rn = 1
    )
  ) mapping
  WHERE mapping.dup_id = agent_persona_files.persona_id
)
WHERE persona_id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
    ) AS rn
    FROM agent_personas
  ) WHERE rn = 1
);

-- Step 6a: Delete persona_skills from duplicates that would conflict with survivor's skills
DELETE FROM persona_skills
WHERE id IN (
  SELECT dps.id
  FROM persona_skills dps
  JOIN (
    SELECT id as dup_id, org_id, name
    FROM agent_personas
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
        ) AS rn
        FROM agent_personas
      ) WHERE rn = 1
    )
  ) dup ON dup.dup_id = dps.persona_id
  JOIN (
    SELECT id as survivor_id, org_id, name
    FROM agent_personas
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
        ) AS rn
        FROM agent_personas
      ) WHERE rn = 1
    )
  ) surv ON surv.org_id = dup.org_id AND surv.name COLLATE NOCASE = dup.name COLLATE NOCASE
  JOIN persona_skills sps ON sps.persona_id = surv.survivor_id AND sps.skill_id = dps.skill_id
);

-- Step 6b: Move remaining persona_skills from duplicates to survivors
UPDATE persona_skills
SET persona_id = (
  SELECT survivor_id FROM (
    SELECT s.id as survivor_id, dup.id as dup_id
    FROM agent_personas s
    JOIN agent_personas dup ON dup.org_id = s.org_id
      AND dup.name COLLATE NOCASE = s.name COLLATE NOCASE
      AND dup.id != s.id
    WHERE s.id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
        ) AS rn
        FROM agent_personas
      ) WHERE rn = 1
    )
  ) mapping
  WHERE mapping.dup_id = persona_skills.persona_id
)
WHERE persona_id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
    ) AS rn
    FROM agent_personas
  ) WHERE rn = 1
);

-- Step 7a: Delete persona_tools from duplicates that would conflict with survivor's tools
DELETE FROM persona_tools
WHERE id IN (
  SELECT dpt.id
  FROM persona_tools dpt
  JOIN (
    SELECT id as dup_id, org_id, name
    FROM agent_personas
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
        ) AS rn
        FROM agent_personas
      ) WHERE rn = 1
    )
  ) dup ON dup.dup_id = dpt.persona_id
  JOIN (
    SELECT id as survivor_id, org_id, name
    FROM agent_personas
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
        ) AS rn
        FROM agent_personas
      ) WHERE rn = 1
    )
  ) surv ON surv.org_id = dup.org_id AND surv.name COLLATE NOCASE = dup.name COLLATE NOCASE
  JOIN persona_tools spt ON spt.persona_id = surv.survivor_id AND spt.service = dpt.service AND spt.action_id = dpt.action_id
);

-- Step 7b: Move remaining persona_tools from duplicates to survivors
UPDATE persona_tools
SET persona_id = (
  SELECT survivor_id FROM (
    SELECT s.id as survivor_id, dup.id as dup_id
    FROM agent_personas s
    JOIN agent_personas dup ON dup.org_id = s.org_id
      AND dup.name COLLATE NOCASE = s.name COLLATE NOCASE
      AND dup.id != s.id
    WHERE s.id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
        ) AS rn
        FROM agent_personas
      ) WHERE rn = 1
    )
  ) mapping
  WHERE mapping.dup_id = persona_tools.persona_id
)
WHERE persona_id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
    ) AS rn
    FROM agent_personas
  ) WHERE rn = 1
);

-- Step 8: Delete duplicate persona rows (keep newest per org_id + name, case-insensitive)
DELETE FROM agent_personas WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY org_id, name COLLATE NOCASE ORDER BY created_at DESC
    ) AS rn
    FROM agent_personas
  ) WHERE rn = 1
);

-- Step 9: Drop the old slug-based unique index and the slug column
DROP INDEX IF EXISTS idx_personas_slug;

-- SQLite doesn't support DROP COLUMN directly in older versions, but D1 uses
-- a recent enough SQLite that supports ALTER TABLE ... DROP COLUMN.
ALTER TABLE agent_personas DROP COLUMN slug;

-- Step 10: Add uniqueness constraint on (org_id, name) with case-insensitive matching
CREATE UNIQUE INDEX idx_personas_org_name ON agent_personas(org_id, name COLLATE NOCASE);
