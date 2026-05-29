import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpClient } from './client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });
}

async function readRpc(req: RequestInit): Promise<{ method: string; params?: Record<string, unknown> }> {
  return JSON.parse(String(req.body));
}

describe('McpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses injected fetch and sends static headers plus negotiated protocol/session headers', async () => {
    const requests: Array<{ url: string; init: RequestInit; rpc: { method: string; params?: Record<string, unknown> } }> = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestInit = init ?? {};
      const rpc = await readRpc(requestInit);
      requests.push({ url: String(url), init: requestInit, rpc });

      if (rpc.method === 'initialize') {
        expect(rpc.params?.protocolVersion).toBe('2025-11-25');
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fake', version: '1.0.0' },
          },
        }, { headers: { 'mcp-session-id': 'session-1' } });
      }

      if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }

      return jsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'query', description: 'Query data', inputSchema: { type: 'object' } }] },
      });
    });
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('global fetch should not be used');
    }));

    const client = new McpClient({
      url: 'https://mcp.example.com',
      serviceName: 'custom',
      additionalHeaders: { 'X-Tenant': 'acme' },
      staticAuthHeader: { name: 'X-API-Key', value: 'secret' },
      fetch: fakeFetch,
    });

    await expect(client.listTools()).resolves.toHaveLength(1);

    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(requests[0].init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Tenant': 'acme',
      'X-API-Key': 'secret',
    });
    expect(requests[1].init.headers).toMatchObject({
      'MCP-Protocol-Version': '2025-11-25',
      'Mcp-Session-Id': 'session-1',
    });
    expect(requests[2].init.headers).toMatchObject({
      'MCP-Protocol-Version': '2025-11-25',
      'Mcp-Session-Id': 'session-1',
      'X-Tenant': 'acme',
      'X-API-Key': 'secret',
    });
  });

  it('rejects unsupported negotiated protocol versions instead of falling back to no-session mode', async () => {
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init ?? {});
      if (rpc.method !== 'initialize') throw new Error('should not call tools/list after unsupported initialize');
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '1900-01-01',
          capabilities: {},
          serverInfo: { name: 'fake', version: '1.0.0' },
        },
      }, { headers: { 'mcp-session-id': 'bad-session' } });
    });

    const client = new McpClient({ url: 'https://mcp.example.com', serviceName: 'custom', fetch: fakeFetch });

    await expect(client.listTools()).rejects.toThrow(/unsupported MCP protocol/i);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('calls the default global fetch with the globalThis receiver', async () => {
    const calls: string[] = [];
    const globalFetch = vi.fn(async function (this: unknown, _url: string | URL | Request, init?: RequestInit) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
      }

      const rpc = await readRpc(init ?? {});
      calls.push(rpc.method);

      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fake', version: '1.0.0' },
          },
        }, { headers: { 'mcp-session-id': 'session-1' } });
      }

      if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }

      return jsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'query', description: 'Query data', inputSchema: { type: 'object' } }] },
      });
    });
    vi.stubGlobal('fetch', globalFetch);

    const client = new McpClient({ url: 'https://mcp.example.com', serviceName: 'custom' });

    await expect(client.listTools('token-1')).resolves.toHaveLength(1);
    expect(globalFetch).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('clears a stale session and retries once when a request returns 404', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init ?? {});
      calls.push(rpc.method);

      if (rpc.method === 'initialize') {
        const sessionId = calls.length === 1 ? 'session-1' : 'session-2';
        return jsonResponse({
          jsonrpc: '2.0',
          id: calls.length,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fake', version: '1.0.0' },
          },
        }, { headers: { 'mcp-session-id': sessionId } });
      }

      if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }

      if (rpc.method === 'tools/list' && calls.filter((m) => m === 'tools/list').length === 1) {
        return new Response('stale session', { status: 404 });
      }

      return jsonResponse({ jsonrpc: '2.0', id: 99, result: { tools: [] } });
    });

    const client = new McpClient({ url: 'https://mcp.example.com', serviceName: 'custom', fetch: fakeFetch });

    await expect(client.listTools()).resolves.toEqual([]);
    expect(calls).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });

  it('rejects additional headers that collide with client-owned headers', async () => {
    const client = new McpClient({
      url: 'https://mcp.example.com',
      serviceName: 'custom',
      additionalHeaders: { Authorization: 'Bearer bad' },
      fetch: vi.fn(),
    });

    await expect(client.listTools()).rejects.toThrow(/protected header/i);
  });
});
