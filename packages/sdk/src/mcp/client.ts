import type { McpTool, McpToolResult, JsonRpcRequest, JsonRpcResponse } from './types.js';

/**
 * Lightweight MCP client using JSON-RPC over HTTP (streamable HTTP transport).
 *
 * Handles the required initialization handshake per the MCP spec:
 * 1. POST initialize → get Mcp-Session-Id
 * 2. POST notifications/initialized (one-way notification)
 * 3. Subsequent requests include Mcp-Session-Id header
 *
 * Supports both JSON and SSE response formats per the Streamable HTTP transport spec.
 */
export class McpClient {
  private url: string;
  private serviceName: string;
  private nextId = 1;

  /** Per-service session IDs to avoid re-initializing on every call. */
  private sessions = new Map<string, string | null>();

  constructor(opts: { url: string; serviceName: string }) {
    this.url = opts.url;
    this.serviceName = opts.serviceName;
  }

  /** Send a JSON-RPC request, handling both JSON and SSE response formats. */
  private async rpc<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    token: string | undefined,
    sessionId?: string | null,
  ): Promise<{ result: T; sessionId: string | null }> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      ...(params !== undefined && { params }),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MCP ${this.serviceName} ${method} failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }

    // Capture session ID from response header
    const respSessionId = res.headers.get('mcp-session-id') ?? sessionId ?? null;

    // Parse response — server may respond with JSON or SSE
    const contentType = res.headers.get('content-type') ?? '';
    let rpcRes: JsonRpcResponse<T>;

    if (contentType.includes('text/event-stream')) {
      // SSE response: parse events to find the JSON-RPC result
      rpcRes = await this.parseSseResponse<T>(res);
    } else {
      rpcRes = (await res.json()) as JsonRpcResponse<T>;
    }

    if (rpcRes.error) {
      throw new Error(`MCP ${this.serviceName} ${method} error: [${rpcRes.error.code}] ${rpcRes.error.message}`);
    }

    return { result: rpcRes.result as T, sessionId: respSessionId };
  }

  /** Parse an SSE response stream to extract the JSON-RPC response. */
  private async parseSseResponse<T>(res: Response): Promise<JsonRpcResponse<T>> {
    const text = await res.text();
    // SSE format: lines like "event: message\ndata: {...}\n\n"
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data) {
          try {
            return JSON.parse(data) as JsonRpcResponse<T>;
          } catch {
            // Not valid JSON, skip
          }
        }
      }
    }
    throw new Error(`MCP ${this.serviceName}: no JSON-RPC message found in SSE response`);
  }

  /** Send a one-way JSON-RPC notification (no id, no response expected). */
  private async notify(
    method: string,
    params: Record<string, unknown> | undefined,
    token: string | undefined,
    sessionId?: string | null,
  ): Promise<void> {
    const req = {
      jsonrpc: '2.0' as const,
      method,
      ...(params !== undefined && { params }),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    // Fire and forget — notifications don't have responses
    await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });
  }

  /**
   * Ensure the session is initialized for this token.
   * MCP Streamable HTTP spec requires initialize before other methods.
   * Falls back to no-session mode if initialize fails (some servers don't require it).
   */
  private async ensureInitialized(token?: string): Promise<string | null> {
    // Key on service name — sessions are server-side and survive token rotation.
    // Using the token as key caused cache misses on every OAuth refresh, forcing
    // redundant initialize + notify round-trips to the MCP server.
    const cacheKey = this.serviceName;
    if (this.sessions.has(cacheKey)) {
      return this.sessions.get(cacheKey) ?? null;
    }

    try {
      const { result, sessionId } = await this.rpc<{
        protocolVersion: string;
        capabilities: Record<string, unknown>;
        serverInfo: { name: string; version: string };
      }>(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'valet', version: '1.0.0' },
        },
        token,
      );

      console.log(`[McpClient] ${this.serviceName} initialized: protocol=${result?.protocolVersion}, sessionId=${sessionId}, server=${result?.serverInfo?.name}/${result?.serverInfo?.version}`);

      this.sessions.set(cacheKey, sessionId);

      // Send initialized notification
      await this.notify('notifications/initialized', undefined, token, sessionId);

      return sessionId;
    } catch (err) {
      console.warn(
        `[McpClient] ${this.serviceName} initialize failed, falling back to no-session mode:`,
        err instanceof Error ? err.message : String(err),
      );
      // Cache null so we don't retry initialization on every call
      this.sessions.set(cacheKey, null);
      return null;
    }
  }

  /** List available tools from the MCP server. */
  async listTools(token?: string): Promise<McpTool[]> {
    const sessionId = await this.ensureInitialized(token);
    const { result } = await this.rpc<{ tools: McpTool[] }>('tools/list', {}, token, sessionId);
    return result?.tools ?? [];
  }

  /** Call a tool by name with arguments. */
  async callTool(token: string | undefined, name: string, args: unknown): Promise<McpToolResult> {
    const sessionId = await this.ensureInitialized(token);
    const { result } = await this.rpc<McpToolResult>('tools/call', { name, arguments: args }, token, sessionId);
    return result;
  }
}
