-- Delete any leftover steps-format workflows so the new dag/v1 runtime
-- is the only thing the worker has to handle. Triggers cascade via
-- their FK to workflows(id) ON DELETE CASCADE.
--
-- This runs once per environment (idempotent: no rows match after the
-- first run). The legacy WorkflowExecutorDO + session-workflows code
-- is removed in the same release, so any execution path for these
-- definitions would 500 anyway — we'd rather they 404 cleanly.
--
-- Audit before delete: workflow_executions rows already have
-- workflow_id ON DELETE SET NULL, so their history survives with a
-- nulled workflow link.
--
-- Malformed-JSON guard: json_extract on an invalid `data` column would
-- raise a parse error and abort the whole migration. Treat any row
-- whose `data` doesn't parse as JSON the same as a non-dag/v1 row and
-- delete it — those workflows can't be executed by the new runtime
-- (and couldn't be executed by the old one either).

DELETE FROM workflows
WHERE data IS NULL
   OR data = ''
   OR json_valid(data) = 0
   OR json_extract(data, '$.version') IS NULL
   OR json_extract(data, '$.version') != 'dag/v1';

-- Drop the now-empty version-history + proposal tables that were tied
-- to the legacy steps runtime. workflow_definition_versions (created in
-- 0018) replaces workflow_version_history; workflow_mutation_proposals
-- had no consumer in dag/v1.

DROP TABLE IF EXISTS workflow_mutation_proposals;
DROP TABLE IF EXISTS workflow_version_history;

-- pending_approvals was the steps-runtime approval table. dag/v1 uses
-- workflow_approvals instead; nothing reads or writes pending_approvals
-- after the runtime swap.
DROP TABLE IF EXISTS pending_approvals;
