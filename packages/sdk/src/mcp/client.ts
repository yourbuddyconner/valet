import type { McpTool, McpToolResult, JsonRpcRequest, JsonRpcResponse } from './types.js';

/**
 * Lightweight MCP client using JSON-RPC over HTTP (streamable HTTP transport).
 * Stateless — no session tracking needed for Notion/Linear streamable HTTP.
 */
export class McpClient {
  private url: string;
  private serviceName: string;
  private nextId = 1;

  constructor(opts: { url: string; serviceName: string }) {
    this.url = opts.url;
    this.serviceName = opts.serviceName;
  }

  /** Send a JSON-RPC request and parse the response. */
  private async rpc<T>(method: string, params: Record<string, unknown> | undefined, token: string): Promise<T> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      ...(params !== undefined && { params }),
    };

    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MCP ${this.serviceName} ${method} failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }

    const rpcRes = (await res.json()) as JsonRpcResponse<T>;

    if (rpcRes.error) {
      throw new Error(`MCP ${this.serviceName} ${method} error: [${rpcRes.error.code}] ${rpcRes.error.message}`);
    }

    return rpcRes.result as T;
  }

  /** List available tools from the MCP server. */
  async listTools(token: string): Promise<McpTool[]> {
    const result = await this.rpc<{ tools: McpTool[] }>('tools/list', {}, token);
    return result?.tools ?? [];
  }

  /** Call a tool by name with arguments. */
  async callTool(token: string, name: string, args: unknown): Promise<McpToolResult> {
    return this.rpc<McpToolResult>('tools/call', { name, arguments: args }, token);
  }
}
