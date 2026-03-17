-- Add composite index for role-filtered message counting in dashboard queries
CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role);

-- Add index on messages.created_at for time-range filtered message queries
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
