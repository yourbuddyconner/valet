-- Consolidated schema for Valet
-- Generated from migrations 0001-0072

-- ═══════════════════════════════════════════════════════════════════════════════
-- Core: Users
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  github_id TEXT,
  github_username TEXT,
  git_name TEXT,
  git_email TEXT,
  onboarding_completed INTEGER DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'member',
  idle_timeout_seconds INTEGER DEFAULT 900,
  model_preferences TEXT,
  discovered_models TEXT,
  max_active_sessions INTEGER DEFAULT NULL,
  ui_queue_mode TEXT DEFAULT 'followup',
  timezone TEXT,
  sandbox_cpu_cores REAL,
  sandbox_memory_mib INTEGER,
  password_hash TEXT,
  identity_provider TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_users_github_id ON users(github_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Auth: API Tokens
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  prefix TEXT,
  scopes TEXT DEFAULT '[]',
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX idx_api_tokens_prefix ON api_tokens(prefix);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Auth: Sessions (OAuth login sessions)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX idx_auth_sessions_token ON auth_sessions(token_hash);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Auth: Unified Credentials (polymorphic owner)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL DEFAULT 'user',
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL DEFAULT 'oauth2',
  encrypted_data TEXT NOT NULL,
  metadata TEXT,
  scopes TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX credentials_owner_unique ON credentials(owner_type, owner_id, provider, credential_type);
CREATE INDEX credentials_owner_lookup ON credentials(owner_type, owner_id);
CREATE INDEX credentials_provider ON credentials(provider);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Auth: MCP OAuth Client Registrations
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE mcp_oauth_clients (
  service TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  registration_endpoint TEXT,
  scopes_supported TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Org: Settings
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  name TEXT NOT NULL DEFAULT 'My Organization',
  allowed_email_domain TEXT,
  allowed_emails TEXT,
  domain_gating_enabled INTEGER DEFAULT 0,
  email_allowlist_enabled INTEGER DEFAULT 0,
  default_session_visibility TEXT NOT NULL DEFAULT 'private'
    CHECK(default_session_visibility IN ('private', 'org_visible', 'org_joinable')),
  model_preferences TEXT,
  enabled_login_providers TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO org_settings (id) VALUES ('default');

-- ═══════════════════════════════════════════════════════════════════════════════
-- Org: API Keys (provider LLM keys)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_api_keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  encrypted_key TEXT NOT NULL,
  set_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  models TEXT,
  show_all_models INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Org: Invites (link-based)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TEXT,
  accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_invites_code ON invites(code);
CREATE INDEX idx_invites_email ON invites(email);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Org: Repositories
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_repositories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL DEFAULT 'github',
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  description TEXT,
  default_branch TEXT DEFAULT 'main',
  language TEXT,
  topics TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_org_repos_full_name ON org_repositories(org_id, full_name);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Org: Service Configs
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_service_configs (
  service TEXT PRIMARY KEY,
  encrypted_config TEXT NOT NULL,
  metadata TEXT,
  configured_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Personas
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE agent_personas (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('private', 'shared')),
  is_default INTEGER NOT NULL DEFAULT 0,
  default_model TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_personas_slug ON agent_personas(org_id, slug);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Persona Files
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE agent_persona_files (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES agent_personas(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_persona_files_name ON agent_persona_files(persona_id, filename);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Persona Tools
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE persona_tools (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES agent_personas(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  action_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_persona_tools_unique ON persona_tools(persona_id, service, action_id);
CREATE INDEX idx_persona_tools_persona ON persona_tools(persona_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Repo-Persona Defaults
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_repo_persona_defaults (
  id TEXT PRIMARY KEY,
  org_repo_id TEXT NOT NULL REFERENCES org_repositories(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL REFERENCES agent_personas(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_repo_persona_default ON org_repo_persona_defaults(org_repo_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Sessions
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'initializing',
  container_id TEXT,
  sandbox_id TEXT,
  tunnel_urls TEXT,
  metadata TEXT,
  snapshot_image_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  persona_id TEXT,
  is_orchestrator INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT 'interactive' CHECK (purpose IN ('interactive', 'orchestrator', 'workflow')),
  created_at TEXT DEFAULT (datetime('now')),
  last_active_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX idx_sessions_created_at ON sessions(created_at);
CREATE INDEX idx_sessions_user_created_at ON sessions(user_id, created_at);
CREATE INDEX idx_sessions_workspace_created_at ON sessions(workspace, created_at);
CREATE INDEX idx_sessions_status_last_active_at ON sessions(status, last_active_at);
CREATE INDEX idx_sessions_purpose_user_status ON sessions(purpose, user_id, status);
CREATE INDEX idx_sessions_archived ON sessions(status, last_active_at DESC) WHERE status = 'archived';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Session Threads
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE session_threads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  opencode_session_id TEXT,
  title TEXT,
  summary_additions INTEGER DEFAULT 0,
  summary_deletions INTEGER DEFAULT 0,
  summary_files INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  message_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_session_threads_session ON session_threads(session_id);
CREATE INDEX idx_session_threads_session_status ON session_threads(session_id, status);
CREATE INDEX idx_session_threads_last_active ON session_threads(session_id, last_active_at);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Messages
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  parts TEXT,
  tool_calls TEXT,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_email TEXT,
  author_name TEXT,
  author_avatar_url TEXT,
  channel_type TEXT,
  channel_id TEXT,
  opencode_session_id TEXT,
  message_format TEXT NOT NULL DEFAULT 'v1',
  thread_id TEXT REFERENCES session_threads(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_session_role ON messages(session_id, role);
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Screenshots
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE screenshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  description TEXT,
  taken_at TEXT DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE INDEX idx_screenshots_session ON screenshots(session_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Session Git State
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE session_git_state (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_type TEXT CHECK(source_type IN ('pr', 'issue', 'branch', 'manual')),
  source_pr_number INTEGER,
  source_issue_number INTEGER,
  source_repo_full_name TEXT,
  source_repo_url TEXT,
  branch TEXT,
  base_branch TEXT,
  commit_count INTEGER DEFAULT 0,
  ref TEXT,
  pr_number INTEGER,
  pr_title TEXT,
  pr_state TEXT CHECK(pr_state IN ('draft', 'open', 'closed', 'merged')),
  pr_url TEXT,
  pr_created_at TEXT,
  pr_merged_at TEXT,
  agent_authored INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_sgs_session ON session_git_state(session_id);
CREATE INDEX idx_sgs_repo_pr ON session_git_state(source_repo_full_name, pr_number);
CREATE INDEX idx_sgs_agent_pr ON session_git_state(agent_authored, pr_state);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Session Files Changed
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE session_files_changed (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('added', 'modified', 'deleted', 'renamed')),
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, file_path)
);

CREATE INDEX idx_sfc_session ON session_files_changed(session_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Session Participants
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE session_participants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'collaborator' CHECK(role IN ('owner', 'collaborator', 'viewer')),
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, user_id)
);

CREATE INDEX idx_sp_session ON session_participants(session_id);
CREATE INDEX idx_sp_user ON session_participants(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Session Share Links
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE session_share_links (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'collaborator' CHECK(role IN ('collaborator', 'viewer')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT,
  max_uses INTEGER,
  use_count INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_ssl_token ON session_share_links(token);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Agent Memories
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE agent_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  workspace TEXT,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_memories_user ON agent_memories(user_id);
CREATE INDEX idx_memories_workspace ON agent_memories(user_id, workspace);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Integrations
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  last_synced_at TEXT,
  scope TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, service)
);

CREATE INDEX idx_integrations_user ON integrations(user_id);
CREATE INDEX idx_integrations_service ON integrations(service);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Workflows
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  data TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);

CREATE INDEX idx_workflows_user ON workflows(user_id);
CREATE INDEX idx_workflows_slug ON workflows(user_id, slug);
CREATE INDEX idx_workflows_enabled ON workflows(enabled);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Triggers (workflow_id nullable for orchestrator-target schedules)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'schedule', 'manual')),
  config TEXT NOT NULL,
  variable_mapping TEXT,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_triggers_user ON triggers(user_id);
CREATE INDEX idx_triggers_workflow ON triggers(workflow_id);
CREATE INDEX idx_triggers_type ON triggers(type);
CREATE INDEX idx_triggers_enabled ON triggers(enabled);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Workflow Executions
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'webhook', 'schedule')),
  trigger_metadata TEXT,
  variables TEXT,
  outputs TEXT,
  steps TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  workflow_version TEXT,
  workflow_hash TEXT,
  workflow_snapshot TEXT,
  idempotency_key TEXT,
  runtime_state TEXT,
  resume_token TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  initiator_type TEXT,
  initiator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_workflow_executions_workflow ON workflow_executions(workflow_id);
CREATE INDEX idx_workflow_executions_user ON workflow_executions(user_id);
CREATE INDEX idx_workflow_executions_trigger ON workflow_executions(trigger_id);
CREATE INDEX idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX idx_workflow_executions_started ON workflow_executions(started_at DESC);
CREATE UNIQUE INDEX idx_workflow_executions_idempotency ON workflow_executions(workflow_id, idempotency_key);
CREATE INDEX idx_workflow_executions_session ON workflow_executions(session_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Workflow Execution Steps
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE workflow_execution_steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped')),
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(execution_id, step_id, attempt)
);

CREATE INDEX idx_workflow_execution_steps_execution ON workflow_execution_steps(execution_id);
CREATE INDEX idx_workflow_execution_steps_status ON workflow_execution_steps(status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Workflow Mutation Proposals
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE workflow_mutation_proposals (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES workflow_executions(id) ON DELETE SET NULL,
  proposed_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  base_workflow_hash TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  diff_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'failed')),
  review_notes TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_workflow_mutation_proposals_workflow ON workflow_mutation_proposals(workflow_id);
CREATE INDEX idx_workflow_mutation_proposals_status ON workflow_mutation_proposals(status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Workflow Version History
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE workflow_version_history (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version TEXT,
  workflow_hash TEXT NOT NULL,
  workflow_data TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('sync', 'update', 'proposal_apply', 'rollback', 'system')),
  source_proposal_id TEXT REFERENCES workflow_mutation_proposals(id) ON DELETE SET NULL,
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workflow_id, workflow_hash)
);

CREATE INDEX idx_workflow_version_history_workflow_created ON workflow_version_history(workflow_id, created_at DESC);
CREATE INDEX idx_workflow_version_history_hash ON workflow_version_history(workflow_hash);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Workflow Schedule Ticks
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE workflow_schedule_ticks (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  tick_bucket TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trigger_id, tick_bucket)
);

CREATE INDEX idx_workflow_schedule_ticks_trigger ON workflow_schedule_ticks(trigger_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Pending Approvals
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  message TEXT NOT NULL,
  timeout_at TEXT,
  default_action TEXT CHECK (default_action IN ('approve', 'reject')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  responded_at TEXT,
  responded_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_pending_approvals_execution ON pending_approvals(execution_id);
CREATE INDEX idx_pending_approvals_status ON pending_approvals(status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Orchestrator Identities
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE orchestrator_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL DEFAULT 'personal',
  name TEXT NOT NULL DEFAULT 'Agent',
  handle TEXT NOT NULL,
  avatar TEXT,
  custom_instructions TEXT,
  persona_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_orch_identity_handle ON orchestrator_identities(org_id, handle);
CREATE UNIQUE INDEX idx_orch_identity_user ON orchestrator_identities(org_id, user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Orchestrator Memory Files (virtual filesystem)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE orchestrator_memory_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL DEFAULT 'default',
  path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 1.0,
  pinned INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_memory_files_user_path ON orchestrator_memory_files(user_id, path);
CREATE INDEX idx_memory_files_user ON orchestrator_memory_files(user_id);
CREATE INDEX idx_memory_files_pinned ON orchestrator_memory_files(user_id, pinned);

-- FTS5 index for memory files (path, title, content)
CREATE VIRTUAL TABLE orchestrator_memory_files_fts USING fts5(
  path,
  title,
  content,
  tokenize='porter unicode61'
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Mailbox Messages
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE mailbox_messages (
  id TEXT PRIMARY KEY,
  from_session_id TEXT,
  from_user_id TEXT,
  to_session_id TEXT,
  to_user_id TEXT,
  message_type TEXT NOT NULL DEFAULT 'message' CHECK (message_type IN ('message', 'notification', 'question', 'escalation', 'approval')),
  content TEXT NOT NULL,
  context_session_id TEXT,
  context_task_id TEXT,
  reply_to_id TEXT REFERENCES mailbox_messages(id) ON DELETE SET NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_mailbox_to_session ON mailbox_messages(to_session_id, read, created_at DESC);
CREATE INDEX idx_mailbox_to_user ON mailbox_messages(to_user_id, read, created_at DESC);
CREATE INDEX idx_mailbox_from_session ON mailbox_messages(from_session_id, created_at DESC);
CREATE INDEX idx_mailbox_reply_to ON mailbox_messages(reply_to_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Session Tasks
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE session_tasks (
  id TEXT PRIMARY KEY,
  orchestrator_session_id TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'blocked')),
  result TEXT,
  parent_task_id TEXT REFERENCES session_tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_session_tasks_orchestrator ON session_tasks(orchestrator_session_id, status, created_at DESC);
CREATE INDEX idx_session_tasks_session ON session_tasks(session_id, status);
CREATE INDEX idx_session_tasks_parent ON session_tasks(parent_task_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Session Task Dependencies
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE session_task_dependencies (
  task_id TEXT NOT NULL REFERENCES session_tasks(id) ON DELETE CASCADE,
  blocked_by_task_id TEXT NOT NULL REFERENCES session_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, blocked_by_task_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- User Notification Preferences (with event_type granularity)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE user_notification_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('message', 'notification', 'question', 'escalation', 'approval')),
  event_type TEXT NOT NULL DEFAULT '*',
  web_enabled INTEGER NOT NULL DEFAULT 1,
  slack_enabled INTEGER NOT NULL DEFAULT 0,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, message_type, event_type)
);

CREATE INDEX idx_notification_prefs_user ON user_notification_preferences(user_id);
CREATE INDEX idx_notification_prefs_lookup ON user_notification_preferences(user_id, message_type, event_type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Channels: User Identity Links
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE user_identity_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_name TEXT,
  team_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, external_id)
);

CREATE INDEX idx_identity_links_user ON user_identity_links(user_id);
CREATE INDEX idx_identity_links_provider ON user_identity_links(provider, external_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Channels: Channel Bindings
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE channel_bindings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  user_id TEXT,
  org_id TEXT NOT NULL,
  queue_mode TEXT NOT NULL DEFAULT 'followup' CHECK (queue_mode IN ('followup', 'collect', 'steer')),
  collect_debounce_ms INTEGER NOT NULL DEFAULT 3000,
  slack_channel_id TEXT,
  slack_thread_ts TEXT,
  slack_initial_message_ts TEXT,
  github_repo_full_name TEXT,
  github_pr_number INTEGER,
  github_comment_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_type, channel_id)
);

CREATE INDEX idx_channel_bindings_session ON channel_bindings(session_id);
CREATE INDEX idx_channel_bindings_scope ON channel_bindings(scope_key);
CREATE INDEX idx_channel_bindings_user ON channel_bindings(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Channels: Channel Thread Mappings
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE channel_thread_mappings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES session_threads(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_seen_ts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_channel_thread_mappings_user_lookup
  ON channel_thread_mappings(channel_type, channel_id, external_thread_id, user_id);
CREATE INDEX idx_channel_thread_mappings_thread ON channel_thread_mappings(thread_id);
CREATE INDEX idx_channel_thread_mappings_session ON channel_thread_mappings(session_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Telegram Config (per-user, without bot_token -- stored in credentials)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE user_telegram_config (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_username TEXT NOT NULL,
  bot_info TEXT NOT NULL,
  webhook_url TEXT,
  webhook_active INTEGER NOT NULL DEFAULT 0,
  owner_telegram_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_telegram_config_unique ON user_telegram_config(user_id);
CREATE INDEX idx_telegram_config_user ON user_telegram_config(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Slack: Org Installs
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_slack_installs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL UNIQUE,
  team_name TEXT,
  bot_user_id TEXT NOT NULL,
  app_id TEXT,
  encrypted_bot_token TEXT NOT NULL,
  encrypted_signing_secret TEXT,
  installed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_org_slack_installs_team ON org_slack_installs(team_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Slack: Link Verifications
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE slack_link_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  slack_display_name TEXT,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_slack_link_verifications_user ON slack_link_verifications(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Custom LLM Providers
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE custom_providers (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  encrypted_key TEXT,
  models TEXT NOT NULL DEFAULT '[]',
  show_all_models INTEGER NOT NULL DEFAULT 0,
  set_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Model Catalog Cache
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE model_catalog_cache (
  cache_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  cached_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Action Policies
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE action_policies (
  id TEXT PRIMARY KEY,
  service TEXT,
  action_id TEXT,
  risk_level TEXT CHECK(risk_level IN ('low','medium','high','critical')),
  mode TEXT NOT NULL CHECK(mode IN ('allow','require_approval','deny')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_ap_action ON action_policies(service, action_id) WHERE action_id IS NOT NULL;
CREATE UNIQUE INDEX idx_ap_service ON action_policies(service) WHERE action_id IS NULL AND risk_level IS NULL AND service IS NOT NULL;
CREATE UNIQUE INDEX idx_ap_risk ON action_policies(risk_level) WHERE service IS NULL AND action_id IS NULL AND risk_level IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Action Invocations
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE action_invocations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  action_id TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  resolved_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','denied','executed','failed','expired')),
  params TEXT,
  result TEXT,
  error TEXT,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  executed_at TEXT,
  expires_at TEXT,
  policy_id TEXT REFERENCES action_policies(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ai_session ON action_invocations(session_id, created_at);
CREATE INDEX idx_ai_user ON action_invocations(user_id, status);
CREATE INDEX idx_ai_pending ON action_invocations(status, expires_at) WHERE status = 'pending';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Disabled Actions
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE disabled_actions (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  action_id TEXT,
  disabled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_da_service ON disabled_actions(service) WHERE action_id IS NULL;
CREATE UNIQUE INDEX idx_da_action ON disabled_actions(service, action_id) WHERE action_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- MCP Tool Cache
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE mcp_tool_cache (
  service TEXT NOT NULL,
  action_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  risk_level TEXT NOT NULL DEFAULT 'medium',
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (service, action_id)
);

CREATE INDEX idx_mcp_tool_cache_service ON mcp_tool_cache(service);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Plugin Registry
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_plugins (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  source TEXT NOT NULL DEFAULT 'builtin',
  capabilities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  action_type TEXT,
  auth_required INTEGER NOT NULL DEFAULT 1,
  installed_by TEXT NOT NULL DEFAULT 'system',
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_org_plugins_name ON org_plugins(org_id, name);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Plugin Artifacts
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_plugin_artifacts (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES org_plugins(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_plugin_artifacts_file ON org_plugin_artifacts(plugin_id, type, filename);
CREATE INDEX idx_plugin_artifacts_plugin ON org_plugin_artifacts(plugin_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Plugin Settings
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_plugin_settings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  allow_repo_content INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_org_plugin_settings_org ON org_plugin_settings(org_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Skills
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  owner_id TEXT,
  source TEXT NOT NULL DEFAULT 'managed',
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_skills_org_slug ON skills(org_id, slug) WHERE source IN ('builtin', 'plugin');
CREATE UNIQUE INDEX idx_skills_org_owner_slug ON skills(org_id, owner_id, slug) WHERE source = 'managed';
CREATE INDEX idx_skills_org_status ON skills(org_id, status);
CREATE INDEX idx_skills_owner ON skills(owner_id) WHERE owner_id IS NOT NULL;

-- FTS5 for skills
CREATE VIRTUAL TABLE skills_fts USING fts5(
  name,
  description,
  content,
  tokenize='porter unicode61'
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Persona Skills
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE persona_skills (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES agent_personas(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_persona_skills_unique ON persona_skills(persona_id, skill_id);
CREATE INDEX idx_persona_skills_persona ON persona_skills(persona_id);
CREATE INDEX idx_persona_skills_skill ON persona_skills(skill_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Org Default Skills
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE org_default_skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_org_default_skills_unique ON org_default_skills(org_id, skill_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Analytics Events (replaces usage_events + session_audit_log)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT,
  turn_id TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  channel TEXT,
  model TEXT,
  queue_mode TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_name TEXT,
  error_code TEXT,
  summary TEXT,
  actor_id TEXT,
  properties TEXT
);

CREATE INDEX idx_analytics_events_type_created ON analytics_events(event_type, created_at);
CREATE INDEX idx_analytics_events_session_created ON analytics_events(session_id, created_at);
CREATE INDEX idx_analytics_events_session_type ON analytics_events(session_id, event_type);
CREATE INDEX idx_analytics_events_user_type_created ON analytics_events(user_id, event_type, created_at);
CREATE INDEX idx_analytics_events_model_created ON analytics_events(model, created_at);
