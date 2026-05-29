import type { McpTool, McpToolResult, JsonRpcRequest, JsonRpcResponse } from './types.js';

const LATEST_MCP_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);

const PROTECTED_ADDITIONAL_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'cookie',
  'date',
  'dnt',
  'expect',
  'origin',
  'referer',
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'permissions-policy',
]);

const HTTP_FIELD_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface McpClientOptions {
  url: string;
  serviceName: string;
  authQueryParam?: string;
  additionalHeaders?: Record<string, string>;
  staticAuthHeader?: { name: string; value: string };
  fetch?: typeof fetch;
}

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
  /** When set, token is sent as a URL query parameter instead of Authorization header. */
  private authQueryParam?: string;
  private additionalHeaders?: Record<string, string>;
  private staticAuthHeader?: { name: string; value: string };
  private fetchFn: typeof fetch;

  /** Per-service session IDs to avoid re-initializing on every call. */
  private sessions = new Map<string, string | null>();
  private protocolVersions = new Map<string, string>();

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.serviceName = opts.serviceName;
    this.authQueryParam = opts.authQueryParam;
    this.additionalHeaders = opts.additionalHeaders;
    this.staticAuthHeader = opts.staticAuthHeader;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Build fetch URL and headers with auth + session. */
  private buildFetchOpts(token?: string, sessionId?: string | null): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = {
      ...this.validateAdditionalHeaders(this.additionalHeaders),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    let url = this.url;
    if (token && this.staticAuthHeader) {
      throw new Error(`MCP ${this.serviceName}: ambiguous auth sources; cannot send both access token and static auth header`);
    }

    if (token && this.authQueryParam) {
      const sep = this.url.includes('?') ? '&' : '?';
      url = `${this.url}${sep}${this.authQueryParam}=${encodeURIComponent(token)}`;
    } else if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else if (this.staticAuthHeader) {
      const header = this.validateStaticAuthHeader(this.staticAuthHeader);
      headers[header.name] = header.value;
    }

    const protocolVersion = this.protocolVersions.get(this.serviceName);
    if (protocolVersion) {
      headers['MCP-Protocol-Version'] = protocolVersion;
    }
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    return { url, headers };
  }

  /** Send a JSON-RPC request, handling both JSON and SSE response formats. */
  private async rpc<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    token: string | undefined,
    sessionId?: string | null,
    retryOnStaleSession = true,
  ): Promise<{ result: T; sessionId: string | null }> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      ...(params !== undefined && { params }),
    };

    const { url: fetchUrl, headers } = this.buildFetchOpts(token, sessionId);

    const res = await this.fetchFn(fetchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      if (res.status === 404 && sessionId && retryOnStaleSession) {
        this.sessions.delete(this.serviceName);
        this.protocolVersions.delete(this.serviceName);
        const nextSessionId = await this.ensureInitialized(token);
        const retry = await this.rpc<T>(method, params, token, nextSessionId, false);
        return retry;
      }

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

    const { url: fetchUrl, headers } = this.buildFetchOpts(token, sessionId);

    // Fire and forget — notifications don't have responses
    await this.fetchFn(fetchUrl, {
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
          protocolVersion: LATEST_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'valet', version: '1.0.0' },
        },
        token,
      );

      const protocolVersion = result?.protocolVersion;
      if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.has(protocolVersion)) {
        throw new Error(`Unsupported MCP protocol version negotiated by ${this.serviceName}: ${protocolVersion}`);
      }

      console.log(`[McpClient] ${this.serviceName} initialized: protocol=${result?.protocolVersion}, sessionId=${sessionId}, server=${result?.serverInfo?.name}/${result?.serverInfo?.version}`);

      this.protocolVersions.set(cacheKey, protocolVersion);
      this.sessions.set(cacheKey, sessionId);

      // Send initialized notification
      await this.notify('notifications/initialized', undefined, token, sessionId);

      return sessionId;
    } catch (err) {
      if (err instanceof Error && /Unsupported MCP protocol version/i.test(err.message)) {
        throw err;
      }

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

  private validateAdditionalHeaders(headers?: Record<string, string>): Record<string, string> {
    if (!headers) return {};

    const normalized = new Set<string>();
    const validated: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lowerName = this.validateHeaderName(name);
      if (normalized.has(lowerName)) {
        throw new Error(`MCP ${this.serviceName}: duplicate additional header "${name}"`);
      }
      normalized.add(lowerName);
      if (PROTECTED_ADDITIONAL_HEADERS.has(lowerName) || lowerName.startsWith('proxy-') || lowerName.startsWith('sec-')) {
        throw new Error(`MCP ${this.serviceName}: protected header "${name}" cannot be configured as an additional header`);
      }
      this.validateHeaderValue(name, value);
      validated[name] = value;
    }
    return validated;
  }

  private validateStaticAuthHeader(header: { name: string; value: string }): { name: string; value: string } {
    const lowerName = this.validateHeaderName(header.name);
    if (
      lowerName !== 'authorization'
      && (PROTECTED_ADDITIONAL_HEADERS.has(lowerName) || lowerName.startsWith('proxy-') || lowerName.startsWith('sec-'))
    ) {
      throw new Error(`MCP ${this.serviceName}: protected header "${header.name}" cannot be used as a static auth header`);
    }
    this.validateHeaderValue(header.name, header.value);
    return header;
  }

  private validateHeaderName(name: string): string {
    if (!HTTP_FIELD_NAME_RE.test(name)) {
      throw new Error(`MCP ${this.serviceName}: invalid header name "${name}"`);
    }
    return name.toLowerCase();
  }

  private validateHeaderValue(name: string, value: string): void {
    if (/[\r\n\0]/.test(value)) {
      throw new Error(`MCP ${this.serviceName}: invalid value for header "${name}"`);
    }
  }
}
