/**
 * OpenCode SDK wrapper for communicating with OpenCode server instances
 * running in containers.
 *
 * Based on the OpenCode SDK API:
 * - Sessions: Create, list, prompt, share, summarize
 * - Files: Search, read, discover
 * - Events: Server-sent events subscription
 */

export interface OpenCodeConfig {
  baseUrl: string;
  password?: string;
  timeout?: number;
}

export interface OpenCodeSession {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenCodeMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
  }>;
  createdAt: string;
}

export interface OpenCodeFile {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface OpenCodeSearchResult {
  path: string;
  line: number;
  content: string;
  context?: {
    before: string[];
    after: string[];
  };
}

export class OpenCodeClient {
  private config: OpenCodeConfig;
  private headers: Record<string, string>;

  constructor(config: OpenCodeConfig) {
    this.config = {
      timeout: 30000,
      ...config,
    };

    this.headers = {
      'Content-Type': 'application/json',
    };

    if (config.password) {
      const auth = btoa(`opencode:${config.password}`);
      this.headers['Authorization'] = `Basic ${auth}`;
    }
  }

  // ============ Health & Info ============

  async health(): Promise<{ status: string; version?: string }> {
    const res = await this.fetch('/health');
    return res.json();
  }

  async getVersion(): Promise<string> {
    const res = await this.fetch('/version');
    const data = await res.json<{ version: string }>();
    return data.version;
  }

  // ============ Session Management ============

  async createSession(path: string): Promise<OpenCodeSession> {
    const res = await this.fetch('/session', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
    return res.json();
  }

  async getSession(id: string): Promise<OpenCodeSession> {
    const res = await this.fetch(`/session/${id}`);
    return res.json();
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    const res = await this.fetch('/session');
    const data = await res.json<{ sessions: OpenCodeSession[] }>();
    return data.sessions;
  }

  async deleteSession(id: string): Promise<void> {
    await this.fetch(`/session/${id}`, { method: 'DELETE' });
  }

  /**
   * Send a prompt to a session and get streaming response
   */
  async prompt(sessionId: string, content: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.fetch(`/session/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });

    if (!res.body) {
      throw new Error('No response body');
    }

    return res.body;
  }

  /**
   * Send a prompt and collect full response (non-streaming)
   */
  async promptSync(sessionId: string, content: string): Promise<OpenCodeMessage> {
    const stream = await this.prompt(sessionId, content);
    const reader = stream.getReader();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullContent += new TextDecoder().decode(value);
    }

    return {
      id: crypto.randomUUID(),
      sessionId,
      role: 'assistant',
      content: fullContent,
      createdAt: new Date().toISOString(),
    };
  }

  async getSessionMessages(sessionId: string): Promise<OpenCodeMessage[]> {
    const res = await this.fetch(`/session/${sessionId}/message`);
    const data = await res.json<{ messages: OpenCodeMessage[] }>();
    return data.messages;
  }

  async shareSession(sessionId: string): Promise<{ url: string }> {
    const res = await this.fetch(`/session/${sessionId}/share`, { method: 'POST' });
    return res.json();
  }

  async summarizeSession(sessionId: string): Promise<{ summary: string }> {
    const res = await this.fetch(`/session/${sessionId}/summarize`, { method: 'POST' });
    return res.json();
  }

  // ============ File Operations ============

  async searchFiles(query: string, options?: { path?: string; limit?: number }): Promise<OpenCodeSearchResult[]> {
    const params = new URLSearchParams({ query });
    if (options?.path) params.set('path', options.path);
    if (options?.limit) params.set('limit', String(options.limit));

    const res = await this.fetch(`/file/search?${params}`);
    const data = await res.json<{ results: OpenCodeSearchResult[] }>();
    return data.results;
  }

  async readFile(path: string): Promise<string> {
    const res = await this.fetch(`/file/read?path=${encodeURIComponent(path)}`);
    const data = await res.json<{ content: string }>();
    return data.content;
  }

  async listFiles(path: string): Promise<OpenCodeFile[]> {
    const res = await this.fetch(`/file/list?path=${encodeURIComponent(path)}`);
    const data = await res.json<{ files: OpenCodeFile[] }>();
    return data.files;
  }

  async discoverFiles(pattern: string): Promise<OpenCodeFile[]> {
    const res = await this.fetch(`/file/discover?pattern=${encodeURIComponent(pattern)}`);
    const data = await res.json<{ files: OpenCodeFile[] }>();
    return data.files;
  }

  // ============ Project & Path Info ============

  async getProject(): Promise<{ path: string; name: string; vcs?: { type: string; branch: string } }> {
    const res = await this.fetch('/project');
    return res.json();
  }

  async listProjects(): Promise<Array<{ path: string; name: string }>> {
    const res = await this.fetch('/project/list');
    const data = await res.json<{ projects: Array<{ path: string; name: string }> }>();
    return data.projects;
  }

  // ============ Events (SSE) ============

  subscribeToEvents(): EventSource {
    const url = new URL('/events', this.config.baseUrl);
    return new EventSource(url.toString());
  }

  // ============ Provider & Model Info ============

  async listProviders(): Promise<Array<{ id: string; name: string; models: string[] }>> {
    const res = await this.fetch('/provider');
    const data = await res.json<{ providers: Array<{ id: string; name: string; models: string[] }> }>();
    return data.providers;
  }

  async listModels(): Promise<Array<{ id: string; name: string; provider: string }>> {
    const res = await this.fetch('/model');
    const data = await res.json<{ models: Array<{ id: string; name: string; provider: string }> }>();
    return data.models;
  }

  // ============ Commands ============

  async listCommands(): Promise<Array<{ name: string; description: string }>> {
    const res = await this.fetch('/command');
    const data = await res.json<{ commands: Array<{ name: string; description: string }> }>();
    return data.commands;
  }

  async runCommand(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetch(`/command/${name}`, {
      method: 'POST',
      body: JSON.stringify(args || {}),
    });
    return res.json();
  }

  // ============ Internal Helpers ============

  private async fetch(path: string, options?: RequestInit): Promise<Response> {
    const url = new URL(path, this.config.baseUrl);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const res = await fetch(url.toString(), {
        ...options,
        headers: {
          ...this.headers,
          ...options?.headers,
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const error = await res.text().catch(() => 'Unknown error');
        throw new Error(`OpenCode API error (${res.status}): ${error}`);
      }

      return res;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Create an OpenCode client instance
 */
export function createOpenCodeClient(config: OpenCodeConfig): OpenCodeClient {
  return new OpenCodeClient(config);
}
