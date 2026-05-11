-- Add parent_thread_id to sessions so child sessions can reliably route
-- idle/completion notifications back to the correct orchestrator thread.
-- Previously this was only stored in the child DO's transient SQL state,
-- which is lost if the child DO is re-initialized.
ALTER TABLE sessions ADD COLUMN parent_thread_id TEXT;
