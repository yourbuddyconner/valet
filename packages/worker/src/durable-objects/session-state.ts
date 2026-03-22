/**
 * SessionState — typed accessors over the DO's `state` key-value table.
 *
 * Replaces stringly-typed getStateValue/setStateValue with typed properties.
 * The underlying storage is unchanged — `state` table with TEXT key/value columns.
 * Parsing, validation, and type coercion happen internally.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionLifecycleStatus =
  | 'initializing'
  | 'running'
  | 'idle'
  | 'hibernating'
  | 'hibernated'
  | 'restoring'
  | 'terminated'
  | 'archived'
  | 'error';

export interface SessionStartParams {
  sessionId: string;
  userId: string;
  workspace: string;
  sandboxId?: string;
  tunnelUrls?: Record<string, string>;
  backendUrl?: string;
  terminateUrl?: string;
  hibernateUrl?: string;
  restoreUrl?: string;
  idleTimeoutMs?: number;
  spawnRequest?: Record<string, unknown>;
  initialPrompt?: string;
  initialModel?: string;
  parentThreadId?: string;
  channelFollowupIntervalMs?: number;
}

export interface TunnelEntry {
  name: string;
  port: number;
  protocol?: string;
  path: string;
  url?: string;
}

// ─── SessionState Class ───────────────────────────────────────────────────────

export class SessionState {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  // ─── Raw Access (used by RunnerLink and PromptQueue deps) ─────────

  get(key: string): string | undefined {
    const rows = this.sql
      .exec('SELECT value FROM state WHERE key = ?', key)
      .toArray();
    return rows.length > 0 ? (rows[0].value as string) : undefined;
  }

  set(key: string, value: string): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)',
      key, value,
    );
  }

  // ─── Identity ─────────────────────────────────────────────────────

  get sessionId(): string {
    return this.get('sessionId') || '';
  }

  get userId(): string {
    return this.get('userId') || '';
  }

  get workspace(): string {
    return this.get('workspace') || '';
  }

  get title(): string | undefined {
    return this.get('title');
  }

  set title(val: string) {
    this.set('title', val);
  }

  get isOrchestrator(): boolean {
    return this.get('isOrchestrator') === 'true';
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  get status(): SessionLifecycleStatus {
    return (this.get('status') as SessionLifecycleStatus) || 'initializing';
  }

  set status(s: SessionLifecycleStatus) {
    this.set('status', s);
  }

  get sandboxId(): string | undefined {
    return this.get('sandboxId') || undefined;
  }

  set sandboxId(id: string | undefined) {
    this.set('sandboxId', id || '');
  }

  get snapshotImageId(): string | undefined {
    return this.get('snapshotImageId') || undefined;
  }

  set snapshotImageId(id: string | undefined) {
    this.set('snapshotImageId', id || '');
  }

  // ─── Backend URLs ─────────────────────────────────────────────────

  get backendUrl(): string | undefined {
    return this.get('backendUrl') || undefined;
  }

  set backendUrl(val: string | undefined) {
    this.set('backendUrl', val || '');
  }

  get terminateUrl(): string | undefined {
    return this.get('terminateUrl') || undefined;
  }

  set terminateUrl(val: string | undefined) {
    this.set('terminateUrl', val || '');
  }

  get hibernateUrl(): string | undefined {
    return this.get('hibernateUrl') || undefined;
  }

  set hibernateUrl(val: string | undefined) {
    this.set('hibernateUrl', val || '');
  }

  get restoreUrl(): string | undefined {
    return this.get('restoreUrl') || undefined;
  }

  set restoreUrl(val: string | undefined) {
    this.set('restoreUrl', val || '');
  }

  // ─── Spawn & Child Sessions ───────────────────────────────────────

  get spawnRequest(): Record<string, unknown> | undefined {
    const raw = this.get('spawnRequest');
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  set spawnRequest(val: Record<string, unknown> | undefined) {
    this.set('spawnRequest', val ? JSON.stringify(val) : '');
  }

  get parentThreadId(): string | undefined {
    return this.get('parentThreadId') || undefined;
  }

  set parentThreadId(val: string | undefined) {
    this.set('parentThreadId', val || '');
  }

  // ─── Timing ───────────────────────────────────────────────────────

  get idleTimeoutMs(): number {
    const raw = this.get('idleTimeoutMs');
    return raw ? parseInt(raw, 10) : 900_000; // default 15min
  }

  set idleTimeoutMs(ms: number) {
    this.set('idleTimeoutMs', String(ms));
  }

  get lastUserActivityAt(): number {
    const raw = this.get('lastUserActivityAt');
    return raw ? parseInt(raw, 10) : 0;
  }

  set lastUserActivityAt(ts: number) {
    this.set('lastUserActivityAt', String(ts));
  }

  get runningStartedAt(): number {
    const raw = this.get('runningStartedAt');
    return raw ? parseInt(raw, 10) : 0;
  }

  set runningStartedAt(ts: number) {
    this.set('runningStartedAt', String(ts));
  }

  get sandboxWakeStartedAt(): number {
    const raw = this.get('sandboxWakeStartedAt');
    return raw ? parseInt(raw, 10) : 0;
  }

  set sandboxWakeStartedAt(ts: number) {
    this.set('sandboxWakeStartedAt', ts ? String(ts) : '');
  }

  // ─── Tunnels ──────────────────────────────────────────────────────

  get tunnelUrls(): Record<string, string> | null {
    const raw = this.get('tunnelUrls');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  set tunnelUrls(urls: Record<string, string> | null) {
    this.set('tunnelUrls', urls ? JSON.stringify(urls) : '');
  }

  get tunnels(): TunnelEntry[] {
    const raw = this.get('tunnels');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  set tunnels(entries: TunnelEntry[]) {
    this.set('tunnels', JSON.stringify(entries));
  }

  // ─── Models ───────────────────────────────────────────────────────

  get availableModels(): Array<{ provider: string; models: { id: string; name: string }[] }> | undefined {
    const raw = this.get('availableModels');
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  set availableModels(val: Array<{ provider: string; models: { id: string; name: string }[] }> | undefined) {
    this.set('availableModels', val ? JSON.stringify(val) : '');
  }

  // ─── Initial Prompt/Model ─────────────────────────────────────────

  get initialPrompt(): string | undefined {
    return this.get('initialPrompt') || undefined;
  }

  set initialPrompt(val: string | undefined) {
    this.set('initialPrompt', val || '');
  }

  get initialModel(): string | undefined {
    return this.get('initialModel') || undefined;
  }

  set initialModel(val: string | undefined) {
    this.set('initialModel', val || '');
  }

  // ─── Channel Follow-up ───────────────────────────────────────────

  get channelFollowupIntervalMs(): number {
    const raw = this.get('channelFollowupIntervalMs');
    return raw ? parseInt(raw, 10) : 300_000; // default 5min
  }

  set channelFollowupIntervalMs(ms: number) {
    this.set('channelFollowupIntervalMs', String(ms));
  }

  // ─── Parent Idle Notification ─────────────────────────────────────

  get lastParentIdleNotice(): string | undefined {
    return this.get('lastParentIdleNotice') || undefined;
  }

  set lastParentIdleNotice(val: string | undefined) {
    this.set('lastParentIdleNotice', val || '');
  }

  get parentIdleNotifyAt(): number {
    const raw = this.get('parentIdleNotifyAt');
    return raw ? parseInt(raw, 10) : 0;
  }

  set parentIdleNotifyAt(ts: number) {
    this.set('parentIdleNotifyAt', ts ? String(ts) : '');
  }

  // ─── Bulk Initialization ──────────────────────────────────────────

  /**
   * Set all initial state values during handleStart.
   * This replaces the sequence of setStateValue calls in the start handler.
   */
  initialize(params: SessionStartParams): void {
    // Identity + lifecycle
    this.set('sessionId', params.sessionId);
    this.set('userId', params.userId);
    this.set('workspace', params.workspace);
    this.status = 'initializing';

    // Clear stale state from previous lifecycle
    this.sandboxId = undefined;
    this.tunnelUrls = null;
    this.tunnels = [];
    this.runningStartedAt = 0;
    this.sandboxWakeStartedAt = 0;
    this.initialPrompt = undefined;
    this.initialModel = undefined;
    this.parentThreadId = undefined;

    // Set optional fields
    if (params.sandboxId) this.sandboxId = params.sandboxId;
    if (params.tunnelUrls) this.tunnelUrls = params.tunnelUrls;
    if (params.backendUrl) this.backendUrl = params.backendUrl;
    if (params.terminateUrl) this.terminateUrl = params.terminateUrl;
    if (params.hibernateUrl) this.hibernateUrl = params.hibernateUrl;
    if (params.restoreUrl) this.restoreUrl = params.restoreUrl;
    if (params.idleTimeoutMs) this.idleTimeoutMs = params.idleTimeoutMs;
    if (params.spawnRequest) this.spawnRequest = params.spawnRequest;
    if (params.initialPrompt) this.initialPrompt = params.initialPrompt;
    if (params.initialModel) this.initialModel = params.initialModel;
    if (params.parentThreadId) this.parentThreadId = params.parentThreadId;
    if (params.channelFollowupIntervalMs) this.channelFollowupIntervalMs = params.channelFollowupIntervalMs;

    // Initialize idle tracking
    this.lastUserActivityAt = Date.now();
  }
}
