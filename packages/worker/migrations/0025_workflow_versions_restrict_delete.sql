-- workflow_definition_versions.workflow_id has ON DELETE CASCADE in
-- migration 0018, so DELETE FROM workflows wipes the version audit
-- chain. The 'execution X ran definition V' link can be retroactively
-- erased.
--
-- We use a BEFORE DELETE trigger to RESTRICT the cascade rather than
-- rebuilding the table — avoids the FK-target-disappears window that
-- a CREATE/INSERT/DROP/RENAME would expose (workflows.published_version_id
-- references workflow_definition_versions(id) and PRAGMA foreign_key_check
-- would fail mid-rebuild if any drift exists).
--
-- The route's DELETE handler is updated to return 409 ConflictError
-- before reaching this trigger; the trigger is defense-in-depth.

CREATE TRIGGER restrict_workflow_delete_with_versions
  BEFORE DELETE ON workflows
  FOR EACH ROW
  WHEN EXISTS (SELECT 1 FROM workflow_definition_versions WHERE workflow_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'workflow has published versions; delete the versions first or use soft-delete');
END;
