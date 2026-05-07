-- Performance indexes identified via HAR analysis of slow API endpoints
-- Targets: /api/dashboard/stats, /api/me/orchestrator, /api/me/notifications, /api/dashboard/adoption

-- Orchestrator session lookup: covers (user_id, is_orchestrator) filter
-- Used by getOrchestratorSession() - was doing index scan + filter on is_orchestrator
CREATE INDEX IF NOT EXISTS idx_sessions_user_orchestrator
  ON sessions(user_id, is_orchestrator, created_at DESC);

-- Session git state adoption metrics: covers created_at range + agent_authored filters
-- Used by /api/dashboard/adoption - was missing created_at in existing idx_sgs_agent_pr
CREATE INDEX IF NOT EXISTS idx_sgs_created_agent
  ON session_git_state(created_at, agent_authored, pr_state);

-- Mailbox thread reply counting: covers the GROUP BY reply_to_id subquery in getUserInbox()
-- Existing idx_mailbox_reply_to only has reply_to_id, needs to_user_id for the WHERE clause
CREATE INDEX IF NOT EXISTS idx_mailbox_reply_user
  ON mailbox_messages(reply_to_id, to_user_id) WHERE reply_to_id IS NOT NULL;

