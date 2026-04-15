/**
 * Typed HTTP client for the Valet worker API.
 *
 * Reads WORKER_URL and API_TOKEN from env. All methods return parsed JSON
 * or throw with status + body on non-2xx responses.
 */

export interface ClientOptions {
  baseUrl: string;
  token: string;
}

export class SmokeClient {
  private baseUrl: string;
  private token: string;

  constructor(opts?: Partial<ClientOptions>) {
    this.baseUrl = opts?.baseUrl || process.env.WORKER_URL || 'http://localhost:8787';
    this.token = opts?.token || process.env.API_TOKEN || 'test-api-token-12345';
  }

  // ─── Raw request ──────────────────────────────────────────────────

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text };
    }

    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status}: ${json?.error || text.slice(0, 200)}`);
      (err as any).status = res.status;
      (err as any).body = json;
      throw err;
    }

    return json as T;
  }

  /** Returns HTTP status code without throwing. */
  async status(method: string, path: string, body?: unknown): Promise<number> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Drain body to avoid leaks
    await res.text();
    return res.status;
  }

  // ─── Health ───────────────────────────────────────────────────────

  async health(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/health`);
    await res.text();
    return res.status;
  }

  // ─── Sessions ─────────────────────────────────────────────────────

  async listSessions(limit = 5) {
    return this.request<{ sessions: any[] }>('GET', `/api/sessions?limit=${limit}`);
  }

  async getSession(id: string) {
    return this.request<any>('GET', `/api/sessions/${encodeURIComponent(id)}`);
  }

  async sendMessage(sessionId: string, content: string) {
    return this.request<{ success: boolean }>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      { content },
    );
  }

  /** Send a prompt to a session (supports threadId, attachments, queueMode, etc.) */
  async sendPrompt(sessionId: string, body: { content: string; threadId?: string; model?: string; queueMode?: string }) {
    return this.request<{ success: boolean }>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
      { queueMode: 'steer', ...body },
    );
  }

  /** Create a new thread on a session. */
  async createThread(sessionId: string) {
    return this.request<{ id: string; sessionId: string }>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/threads`,
    );
  }

  async getMessages(sessionId: string, opts?: { limit?: number; after?: string; threadId?: string }) {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.after) params.set('after', opts.after);
    if (opts?.threadId) params.set('threadId', opts.threadId);
    const qs = params.toString();
    return this.request<{ messages: Message[] }>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`,
    );
  }

  async availableModels() {
    return this.request<{ models: any[] }>('GET', '/api/sessions/available-models');
  }

  async getSessionTunnels(id: string) {
    return this.request<{ gatewayUrl: string | null; tunnels: any[] }>(
      'GET',
      `/api/sessions/${encodeURIComponent(id)}/tunnels`,
    );
  }

  // ─── Orchestrator ─────────────────────────────────────────────────

  async getOrchestrator() {
    return this.request<{
      sessionId: string;
      identity: any;
      session: any;
      exists: boolean;
      needsRestart: boolean;
    }>('GET', '/api/me/orchestrator');
  }

  async getOrchestratorIdentity() {
    return this.request<any>('GET', '/api/me/orchestrator/identity');
  }

  // ─── Memory ───────────────────────────────────────────────────────

  async memoryRead(path: string) {
    return this.request<any>('GET', `/api/me/memory?path=${encodeURIComponent(path)}`);
  }

  async memoryWrite(path: string, content: string) {
    return this.request<any>('PUT', '/api/me/memory', { path, content });
  }

  async memoryPatch(path: string, operations: any[]) {
    return this.request<any>('PATCH', '/api/me/memory', { path, operations });
  }

  async memoryDelete(path: string) {
    return this.request<any>('DELETE', `/api/me/memory?path=${encodeURIComponent(path)}`);
  }

  async memorySearch(query: string) {
    return this.request<any>('GET', `/api/me/memory/search?query=${encodeURIComponent(query)}`);
  }

  // ─── Personas ─────────────────────────────────────────────────────

  async listPersonas() {
    return this.request<{ personas: any[] }>('GET', '/api/personas');
  }

  async createPersona(data: { name: string; slug: string; description?: string; visibility?: string }) {
    return this.request<{ persona: any }>('POST', '/api/personas', data);
  }

  async getPersona(id: string) {
    return this.request<any>('GET', `/api/personas/${id}`);
  }

  async deletePersona(id: string) {
    return this.request<any>('DELETE', `/api/personas/${id}`);
  }

  // ─── Workflows ────────────────────────────────────────────────────

  async listWorkflows() {
    return this.request<{ workflows: any[] }>('GET', '/api/workflows');
  }

  async syncWorkflow(data: { id: string; name: string; slug: string; description?: string; data: any }) {
    return this.request<any>('POST', '/api/workflows/sync', data);
  }

  async getWorkflow(id: string) {
    return this.request<any>('GET', `/api/workflows/${id}`);
  }

  async deleteWorkflow(id: string) {
    return this.request<any>('DELETE', `/api/workflows/${id}`);
  }

  // ─── Triggers ─────────────────────────────────────────────────────

  async listTriggers() {
    return this.request<{ triggers: any[] }>('GET', '/api/triggers');
  }

  // ─── Executions ───────────────────────────────────────────────────

  async listExecutions(limit = 5) {
    return this.request<{ executions: any[] }>('GET', `/api/executions?limit=${limit}`);
  }

  // ─── Dashboard ────────────────────────────────────────────────────

  async dashboardStats() {
    return this.request<any>('GET', '/api/dashboard/stats');
  }

  // ─── Integrations ─────────────────────────────────────────────────

  async listIntegrations() {
    return this.request<any>('GET', '/api/integrations');
  }

  // ─── Admin ────────────────────────────────────────────────────────

  async adminListUsers() {
    return this.request<any>('GET', '/api/admin/users');
  }

  async adminListOrchestrators() {
    return this.request<any>('GET', '/api/admin/orchestrators');
  }

  // ─── Notifications ────────────────────────────────────────────────

  async listNotifications(limit = 50) {
    return this.request<any>('GET', `/api/me/notifications?limit=${limit}`);
  }

  // ─── Channels ─────────────────────────────────────────────────────

  async getChannelLabel(channelType: string, channelId: string) {
    return this.request<{ label: string | null }>(
      'GET',
      `/api/channels/label?channelType=${encodeURIComponent(channelType)}&channelId=${encodeURIComponent(channelId)}`,
    );
  }

  // ─── API Keys ─────────────────────────────────────────────────────

  async listApiKeys() {
    return this.request<any>('GET', '/api/api-keys');
  }

  // ─── Threads ──────────────────────────────────────────────────────

  async listThreads(sessionId: string) {
    return this.request<{ threads: any[] }>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/threads`,
    );
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  parts?: any;
  createdAt: string | number;
  threadId?: string;
  channelType?: string;
  channelId?: string;
  [key: string]: unknown;
}
