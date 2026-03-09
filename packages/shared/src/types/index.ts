import type { MessagePart } from './message-parts.js';

// Integration types
export type IntegrationService =
  | 'github'
  | 'gmail'
  | 'google_calendar'
  | 'google_drive'
  | 'notion'
  | 'linear'
  | 'hubspot'
  | 'ashby'
  | 'discord'
  | 'slack'
  | 'xero';

export interface Integration {
  id: string;
  userId: string;
  service: IntegrationService;
  config: IntegrationConfig;
  status: 'active' | 'error' | 'pending' | 'disconnected';
  scope: 'user' | 'org';
  createdAt: Date;
  updatedAt: Date;
}

export interface IntegrationConfig {
  entities: string[];
  filters?: Record<string, unknown>;
}

// EventBus types
export type EventBusEventType =
  | 'session.update'
  | 'session.started'
  | 'session.completed'
  | 'session.errored'
  | 'sandbox.status'
  | 'question.asked'
  | 'question.answered'
  | 'notification'
  | 'action.approval_required'
  | 'action.approved'
  | 'action.denied';

export interface EventBusEvent {
  type: EventBusEventType;
  sessionId?: string;
  userId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// Question types
export type QuestionStatus = 'pending' | 'answered' | 'expired';

export interface AgentQuestion {
  id: string;
  sessionId: string;
  text: string;
  options?: string[];
  status: QuestionStatus;
  answer?: string | boolean;
  createdAt: Date;
  answeredAt?: Date;
  expiresAt?: Date;
}

// Git state types
export type SessionSourceType = 'pr' | 'issue' | 'branch' | 'manual';
export type PRState = 'draft' | 'open' | 'closed' | 'merged';

export interface SessionGitState {
  id: string;
  sessionId: string;
  sourceType: SessionSourceType | null;
  sourcePrNumber: number | null;
  sourceIssueNumber: number | null;
  sourceRepoFullName: string | null;
  sourceRepoUrl: string | null;
  branch: string | null;
  ref: string | null;
  baseBranch: string | null;
  commitCount: number;
  prNumber: number | null;
  prTitle: string | null;
  prState: PRState | null;
  prUrl: string | null;
  prCreatedAt: string | null;
  prMergedAt: string | null;
  agentAuthored: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdoptionMetrics {
  totalPRsCreated: number;
  totalPRsMerged: number;
  mergeRate: number;
  totalCommits: number;
}

// Session files changed tracking
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface SessionFileChanged {
  id: string;
  sessionId: string;
  filePath: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
}

// Child session summary (for parent session sidebar)
export interface ChildSessionSummary {
  id: string;
  title?: string;
  status: SessionStatus;
  workspace: string;
  prNumber?: number;
  prState?: PRState;
  prUrl?: string;
  createdAt: string;
}

export interface ListChildSessionsResponse {
  children: ChildSessionSummary[];
  cursor?: string;
  hasMore: boolean;
  totalCount: number;
}

// Session types
export type SessionStatus = 'initializing' | 'running' | 'idle' | 'hibernating' | 'hibernated' | 'restoring' | 'terminated' | 'archived' | 'error';
export type SessionPurpose = 'interactive' | 'orchestrator' | 'workflow';

// Lightweight participant info for list views
export interface SessionParticipantSummary {
  userId: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  role: SessionParticipantRole;
}

export interface AgentSession {
  id: string;
  userId: string;
  workspace: string;
  status: SessionStatus;
  purpose?: SessionPurpose;
  title?: string;
  parentSessionId?: string;
  containerId?: string;
  sandboxId?: string;
  tunnelUrls?: Record<string, string>;
  tunnels?: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }>;
  gatewayUrl?: string;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  createdAt: Date;
  lastActiveAt: Date;
  // Owner info (populated in list views)
  ownerName?: string;
  ownerEmail?: string;
  ownerAvatarUrl?: string;
  // Participant summary (populated in list views)
  participantCount?: number;
  participants?: SessionParticipantSummary[];
  // Persona info
  personaId?: string;
  personaName?: string;
  // Orchestrator flag
  isOrchestrator?: boolean;
  // Cumulative active seconds (excludes hibernation time)
  activeSeconds?: number;
  // Convenience flag for current user
  isOwner?: boolean;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  parts?: MessagePart[];
  authorId?: string;
  authorEmail?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  createdAt: Date;
}

// Diff types
export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  diff?: string;
}

// Auth types
export type AuthProvider = 'github' | 'google';

// User & Organization types
export type UserRole = 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  githubId?: string;
  githubUsername?: string;
  gitName?: string;
  gitEmail?: string;
  onboardingCompleted?: boolean;
  idleTimeoutSeconds?: number;
  sandboxCpuCores?: number;
  sandboxMemoryMib?: number;
  modelPreferences?: string[];
  uiQueueMode?: QueueMode;
  timezone?: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

// Session participant types (multiplayer)
export type SessionParticipantRole = 'owner' | 'collaborator' | 'viewer';

export interface SessionParticipant {
  id: string;
  sessionId: string;
  userId: string;
  role: SessionParticipantRole;
  addedBy?: string;
  createdAt: Date;
  // Joined from users table:
  userName?: string;
  userEmail?: string;
  userAvatarUrl?: string;
}

export interface SessionShareLink {
  id: string;
  sessionId: string;
  token: string;
  role: SessionParticipantRole;
  createdBy: string;
  expiresAt?: Date;
  maxUses?: number;
  useCount: number;
  active: boolean;
  createdAt: Date;
}

export type SessionVisibility = 'private' | 'org_visible' | 'org_joinable';

export interface OrgSettings {
  id: string;
  name: string;
  allowedEmailDomain?: string;
  allowedEmails?: string;
  domainGatingEnabled: boolean;
  emailAllowlistEnabled: boolean;
  defaultSessionVisibility: SessionVisibility;
  modelPreferences?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface OrgApiKey {
  id: string;
  provider: string;
  isSet: boolean;
  models?: Array<{ id: string; name?: string }>;
  showAllModels: boolean;
  setBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserCredential {
  id: string;
  provider: string;
  isSet: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Invite {
  id: string;
  code: string;
  email?: string;
  role: UserRole;
  invitedBy: string;
  acceptedAt?: Date;
  acceptedBy?: string;
  expiresAt: Date;
  createdAt: Date;
}

// Dashboard types
export interface DashboardHeroStats {
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  uniqueRepos: number;
  totalToolCalls: number;
  totalSessionDurationSeconds: number;
  avgSessionDurationSeconds: number;
  estimatedLinesChanged: number;
  sessionHours: number;
}

export interface DashboardDelta {
  sessions: number;
  messages: number;
}

export interface DashboardDayActivity {
  date: string;
  sessions: number;
  messages: number;
}

export interface DashboardTopRepo {
  workspace: string;
  sessionCount: number;
  messageCount: number;
}

export interface DashboardRecentSession {
  id: string;
  workspace: string;
  status: SessionStatus;
  messageCount: number;
  toolCallCount: number;
  durationSeconds: number;
  createdAt: string;
  lastActiveAt: string;
  errorMessage?: string;
}

export interface DashboardActiveSession {
  id: string;
  workspace: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
}

export interface DashboardStatsResponse {
  hero: DashboardHeroStats;
  userHero: DashboardHeroStats;
  delta: DashboardDelta;
  activity: DashboardDayActivity[];
  topRepos: DashboardTopRepo[];
  recentSessions: DashboardRecentSession[];
  activeSessions: DashboardActiveSession[];
  period: number;
}

// API Request/Response types
export interface CreateSessionRequest {
  workspace: string;
  repoUrl?: string;
  branch?: string;
  ref?: string;
  title?: string;
  parentSessionId?: string;
  config?: {
    memory?: string;
    timeout?: number;
  };
  sourceType?: SessionSourceType;
  sourcePrNumber?: number;
  sourceIssueNumber?: number;
  sourceRepoFullName?: string;
  initialPrompt?: string;
  initialModel?: string;
  personaId?: string;
}

export interface CreateSessionResponse {
  session: AgentSession;
  websocketUrl: string;
  tunnelUrls?: Record<string, string>;
}

export interface SendMessageRequest {
  content: string;
  attachments?: Attachment[];
}

export interface Attachment {
  type: 'file' | 'url';
  name: string;
  data: string;
  mimeType?: string;
}

export type SessionOwnershipFilter = 'all' | 'mine' | 'shared';

export interface ListSessionsResponse {
  sessions: AgentSession[];
  cursor?: string;
  hasMore: boolean;
}

export interface ConfigureIntegrationRequest {
  service: IntegrationService;
  credentials: Record<string, string>;
  config: IntegrationConfig;
}

// Custom LLM provider types
export interface CustomProviderModel {
  id: string;
  name?: string;
  contextLimit?: number;
  outputLimit?: number;
}

export interface CustomProvider {
  id: string;
  providerId: string;
  displayName: string;
  baseUrl: string;
  hasKey: boolean;
  models: CustomProviderModel[];
  showAllModels: boolean;
  setBy: string;
  createdAt: string;
  updatedAt: string;
}

// Webhook types
export interface WebhookPayload {
  service: IntegrationService;
  event: string;
  data: unknown;
  timestamp: Date;
}

// GitHub-specific types
export namespace GitHub {
  export interface Repository {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    description: string | null;
    url: string;
    defaultBranch: string;
  }

  export interface Issue {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    labels: string[];
    assignees: string[];
    createdAt: Date;
    updatedAt: Date;
  }

  export interface PullRequest {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed' | 'merged';
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    createdAt: Date;
    updatedAt: Date;
    mergedAt: Date | null;
  }

  export interface SyncConfig {
    repositories?: string[];
    syncIssues: boolean;
    syncPullRequests: boolean;
    syncCommits: boolean;
  }
}

// Gmail-specific types
export namespace Gmail {
  export interface Email {
    id: string;
    threadId: string;
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    bodyHtml?: string;
    snippet: string;
    labels: string[];
    date: Date;
    attachments: Attachment[];
    isUnread: boolean;
    isStarred: boolean;
  }

  export interface Attachment {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
  }

  export interface SendEmailOptions {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    bodyHtml?: string;
    replyTo?: string;
    threadId?: string;
    attachments?: Array<{
      filename: string;
      mimeType: string;
      data: string;
    }>;
  }

  export interface Label {
    id: string;
    name: string;
    type: 'system' | 'user';
  }

  export interface SyncConfig {
    syncMessages: boolean;
    syncLabels: boolean;
    labelFilter?: string[];
  }
}

// Google Calendar-specific types
export namespace GoogleCalendar {
  export interface Calendar {
    id: string;
    summary: string;
    description?: string;
    timeZone: string;
    primary?: boolean;
    accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  }

  export interface Event {
    id: string;
    calendarId: string;
    title: string;
    description?: string;
    location?: string;
    start: Date;
    end: Date;
    isAllDay: boolean;
    timeZone?: string;
    attendees: Attendee[];
    organizer?: { email: string; name?: string };
    meetingLink?: string;
    recurrence?: string[];
    status: 'confirmed' | 'tentative' | 'cancelled';
    htmlLink: string;
  }

  export interface Attendee {
    email: string;
    name?: string;
    status: 'needsAction' | 'declined' | 'tentative' | 'accepted';
    isOrganizer: boolean;
  }

  export interface CreateEventOptions {
    calendarId?: string;
    title: string;
    description?: string;
    location?: string;
    start: Date | string;
    end: Date | string;
    isAllDay?: boolean;
    timeZone?: string;
    attendees?: Array<{ email: string; optional?: boolean }>;
    sendUpdates?: 'all' | 'externalOnly' | 'none';
  }

  export interface FreeBusySlot {
    start: Date;
    end: Date;
  }

  export interface SyncConfig {
    syncCalendars: boolean;
    syncEvents: boolean;
    calendarIds?: string[];
  }
}

// Org repository types
export interface OrgRepository {
  id: string;
  orgId: string;
  provider: string;
  owner: string;
  name: string;
  fullName: string;
  description?: string;
  defaultBranch: string;
  language?: string;
  topics?: string[];
  enabled: boolean;
  personaId?: string;
  personaName?: string;
  createdAt: string;
  updatedAt: string;
}

// Agent persona types
export type PersonaVisibility = 'private' | 'shared';

export interface AgentPersona {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  defaultModel?: string;
  visibility: PersonaVisibility;
  isDefault: boolean;
  createdBy: string;
  creatorName?: string;
  files?: AgentPersonaFile[];
  fileCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPersonaFile {
  id: string;
  personaId: string;
  filename: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// Orchestrator types
export type OrchestratorType = 'personal' | 'org';

export interface OrchestratorIdentity {
  id: string;
  userId?: string;
  orgId: string;
  type: OrchestratorType;
  name: string;
  handle: string;
  avatar?: string;
  customInstructions?: string;
  createdAt: string;
  updatedAt: string;
}

// Memory file system types
export interface MemoryFile {
  id: string;
  userId: string;
  orgId: string;
  path: string;
  content: string;
  title: string;
  relevance: number;
  pinned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
}

export interface MemoryFileListing {
  path: string;
  size: number;
  updatedAt: string;
  pinned: boolean;
}

export type PatchOperation =
  | { op: 'append'; content: string }
  | { op: 'prepend'; content: string }
  | { op: 'replace'; old: string; new: string }
  | { op: 'replace_all'; old: string; new: string }
  | { op: 'insert_after'; anchor: string; content: string }
  | { op: 'delete_section'; heading: string };

export interface PatchResult {
  content: string;
  version: number;
  applied: number;
  skipped: string[];
}

export interface MemoryFileSearchResult {
  path: string;
  snippet: string;
  relevance: number;
}

export interface OrchestratorInfo {
  sessionId: string;
  identity: OrchestratorIdentity | null;
  session: AgentSession | null;
  exists: boolean;
}

// ─── Phase C: Messaging + Coordination Types ─────────────────────────────

// Mailbox types (cross-session/cross-user persistent messaging)
export type MailboxMessageType = 'message' | 'notification' | 'question' | 'escalation' | 'approval';

export interface MailboxMessage {
  id: string;
  fromSessionId?: string;
  fromUserId?: string;
  toSessionId?: string;
  toUserId?: string;
  messageType: MailboxMessageType;
  content: string;
  contextSessionId?: string;
  contextTaskId?: string;
  replyToId?: string;
  read: boolean;
  createdAt: string;
  updatedAt: string;
  // Joined display names (populated in queries)
  fromSessionTitle?: string;
  fromUserName?: string;
  fromUserEmail?: string;
  toSessionTitle?: string;
  toUserName?: string;
  // Thread summary fields (populated in inbox list query only)
  replyCount?: number;
  lastActivityAt?: string;
}

// Session task types (orchestrator-scoped task board)
export type SessionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export interface SessionTask {
  id: string;
  orchestratorSessionId: string;
  sessionId?: string;
  title: string;
  description?: string;
  status: SessionTaskStatus;
  result?: string;
  parentTaskId?: string;
  blockedBy?: string[];
  createdAt: string;
  updatedAt: string;
  // Joined display info
  sessionTitle?: string;
}

// User notification preferences
export interface UserNotificationPreference {
  id: string;
  userId: string;
  messageType: MailboxMessageType;
  // Event-specific key within messageType, '*' means "all events in this type".
  eventType: string;
  webEnabled: boolean;
  slackEnabled: boolean;
  emailEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Phase D: Channel System Types ──────────────────────────────────────

export type ChannelType = 'web' | 'slack' | 'github' | 'api' | 'telegram';
export type QueueMode = 'followup' | 'collect' | 'steer';

export interface ChannelMessage {
  channelType: ChannelType;
  channelId: string;
  scopeKey: string;
  userId?: string;
  externalUserId?: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface UserIdentityLink {
  id: string;
  userId: string;
  provider: string;
  externalId: string;
  externalName?: string;
  teamId?: string;
  createdAt: string;
}

export interface ChannelBinding {
  id: string;
  sessionId: string;
  channelType: ChannelType;
  channelId: string;
  scopeKey: string;
  userId?: string;
  orgId: string;
  queueMode: QueueMode;
  collectDebounceMs: number;
  slackChannelId?: string;
  slackThreadTs?: string;
  githubRepoFullName?: string;
  githubPrNumber?: number;
  createdAt: string;
}

// ─── Telegram Config Types ───────────────────────────────────────────────────

export interface UserTelegramConfig {
  id: string;
  userId: string;
  botUsername: string;
  botInfo: string;
  webhookActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Slash Command Registry ──────────────────────────────────────────────────

export type SlashCommandHandler = 'local' | 'websocket' | 'api' | 'opencode';
export type SlashCommandChannel = 'ui' | 'telegram' | 'slack';
export type SlashCommandCategory = 'Agent' | 'Session' | 'OpenCode';

export interface SlashCommand {
  name: string;
  description: string;
  handler: SlashCommandHandler;
  availableIn: SlashCommandChannel[];
  args?: string;
  category: SlashCommandCategory;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'List available commands', handler: 'local', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'model', description: 'Switch AI model', handler: 'local', availableIn: ['ui'], args: '[query]', category: 'Session' },
  { name: 'diff', description: 'Show git changes since session start', handler: 'websocket', availableIn: ['ui'], category: 'Agent' },
  { name: 'review', description: 'Code review of changed files', handler: 'websocket', availableIn: ['ui'], category: 'Agent' },
  { name: 'stop', description: 'Abort current agent work', handler: 'websocket', availableIn: ['ui', 'telegram', 'slack'], category: 'Agent' },
  { name: 'clear', description: 'Clear prompt queue', handler: 'api', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'status', description: 'Show session status + children', handler: 'api', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'refresh', description: 'Restart orchestrator session', handler: 'api', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'sessions', description: 'List child sessions with status', handler: 'api', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'undo', description: 'Undo last agent change', handler: 'opencode', availableIn: ['ui'], category: 'OpenCode' },
  { name: 'redo', description: 'Redo last undo', handler: 'opencode', availableIn: ['ui'], category: 'OpenCode' },
  { name: 'compact', description: 'Compact/summarize conversation', handler: 'opencode', availableIn: ['ui'], category: 'OpenCode' },
  { name: 'new-session', description: 'Start fresh AI context (keeps history)', handler: 'websocket', availableIn: ['ui'], category: 'Session' },
];

// Model discovery types
export interface ProviderModelEntry { id: string; name: string }
export interface ProviderModels { provider: string; models: ProviderModelEntry[] }
export type AvailableModels = ProviderModels[];

// Audit log types
export type AuditLogEventType =
  | 'session.started'
  | 'session.terminated'
  | 'session.hibernated'
  | 'session.restored'
  | 'user.prompt'
  | 'user.abort'
  | 'user.answer'
  | 'user.joined'
  | 'user.left'
  | 'agent.tool_call'
  | 'agent.tool_completed'
  | 'agent.error'
  | 'agent.turn_complete'
  | 'git.pr_created';

export interface AuditLogEntry {
  id: string;
  sessionId: string;
  eventType: AuditLogEventType;
  summary: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ─── Action Policy Types ────────────────────────────────────────────────────

export type ActionMode = 'allow' | 'require_approval' | 'deny';
export type ActionInvocationStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'failed' | 'expired';

export interface ActionPolicy {
  id: string;
  service?: string;
  actionId?: string;
  riskLevel?: string;
  mode: ActionMode;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DisabledAction {
  id: string;
  service: string;
  actionId?: string | null;
  disabledBy: string;
  createdAt: string;
}

export interface ActionInvocation {
  id: string;
  sessionId: string;
  userId: string;
  service: string;
  actionId: string;
  riskLevel: string;
  resolvedMode: ActionMode;
  status: ActionInvocationStatus;
  params?: string;
  result?: string;
  error?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  executedAt?: string;
  expiresAt?: string;
  policyId?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Usage & Cost Types ──────────────────────────────────────────────────────

export interface UsageStatsResponse {
  hero: {
    totalCost: number | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalSessions: number;
    totalUsers: number;
    sandboxCost: number;
    sandboxActiveSeconds: number;
  };
  costByDay: Array<{
    date: string;
    cost: number | null;
    inputTokens: number;
    outputTokens: number;
    sandboxCost: number;
    sandboxActiveSeconds: number;
  }>;
  byUser: Array<{
    userId: string;
    email: string;
    name?: string;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    sessionCount: number;
    sandboxCost: number;
    sandboxActiveSeconds: number;
  }>;
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    callCount: number;
    percentage: number;
  }>;
  period: number;
}

// Plugin types
export interface OrgPlugin {
  id: string;
  orgId: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  actionType?: string;
  authRequired: boolean;
  source: string;
  capabilities: string[];
  status: string;
  installedBy: string;
  installedAt: string;
  updatedAt: string;
}

export interface OrgPluginArtifact {
  id: string;
  pluginId: string;
  type: 'skill' | 'persona' | 'tool';
  filename: string;
  content: string;
  sortOrder: number;
}

export interface OrgPluginSettings {
  allowRepoContent: boolean;
}

export interface PluginContentPayload {
  personas: Array<{ filename: string; content: string; sortOrder: number }>;
  skills: Array<{ filename: string; content: string }>;
  tools: Array<{ filename: string; content: string }>;
  allowRepoContent: boolean;
}

// --- Skills ---

export type SkillSource = 'builtin' | 'plugin' | 'managed';
export type SkillVisibility = 'private' | 'shared';

export interface Skill {
  id: string;
  orgId: string;
  ownerId: string | null;
  source: SkillSource;
  name: string;
  slug: string;
  description: string | null;
  content: string;
  visibility: SkillVisibility;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  source: SkillSource;
  visibility: SkillVisibility;
  ownerId: string | null;
  updatedAt: string;
}

export interface PersonaSkillAttachment {
  id: string;
  personaId: string;
  skillId: string;
  sortOrder: number;
  createdAt: string;
}
