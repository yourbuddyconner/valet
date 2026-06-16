-- Webhook paths must be globally unique across tenants. Today the
-- legacy /webhooks/:path lookup at lib/db/webhooks.ts has no user_id
-- scope and resolves a path non-deterministically when two tenants
-- register the same value — an unauthenticated request could
-- dispatch into the wrong tenant's workflow.
--
-- Step 1: identify collisions and rename all-but-the-oldest copy with
-- a `-conflict-<rowid>` suffix. Also disable the renamed triggers
-- (enabled=0) so external services hitting the renamed URL get a
-- clean 404 instead of silently sending payloads into the void.
--
-- Step 2: add a partial unique index covering only webhook triggers.

WITH dupes AS (
  SELECT
    id,
    json_extract(config, '$.path') AS path,
    ROW_NUMBER() OVER (
      PARTITION BY json_extract(config, '$.path')
      ORDER BY created_at ASC, id ASC
    ) AS row_num
  FROM triggers
  WHERE type = 'webhook'
)
UPDATE triggers
  SET
    config = json_set(config, '$.path', json_extract(config, '$.path') || '-conflict-' || id),
    enabled = 0,
    updated_at = datetime('now')
  WHERE id IN (SELECT id FROM dupes WHERE row_num > 1);

CREATE UNIQUE INDEX idx_triggers_webhook_path_unique
  ON triggers (json_extract(config, '$.path'))
  WHERE type = 'webhook';
