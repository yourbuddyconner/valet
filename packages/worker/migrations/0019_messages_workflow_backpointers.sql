-- 0019_messages_workflow_backpointers.sql
-- Add back-pointer columns to messages for workflow-originated rows.
-- All nullable; only populated for workflow-chat-message-derived rows.
-- See docs/specs/2026-05-23-workflow-ui-design.md (Phase D).

ALTER TABLE messages ADD COLUMN workflow_execution_id TEXT;
ALTER TABLE messages ADD COLUMN workflow_step_id TEXT;
ALTER TABLE messages ADD COLUMN workflow_iteration_path TEXT;

CREATE INDEX idx_messages_workflow_execution
  ON messages (workflow_execution_id);
