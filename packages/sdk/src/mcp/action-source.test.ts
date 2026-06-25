import { describe, expect, it, vi } from 'vitest';
import { McpActionSource } from './action-source.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });
}

async function readRpc(init?: RequestInit): Promise<{ method: string; id: number }> {
  return JSON.parse(String(init?.body));
}

describe('McpActionSource', () => {
  it('uses a text output schema when an MCP tool does not advertise one', async () => {
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: rpc.id,
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
        id: rpc.id,
        result: {
          tools: [{
            name: 'query',
            description: 'Query data',
            inputSchema: { type: 'object' },
          }],
        },
      });
    });

    const source = new McpActionSource({
      mcpUrl: 'https://mcp.example.com',
      serviceName: 'custom',
      noAuth: true,
      fetch: fakeFetch,
    });

    await expect(source.listActions()).resolves.toMatchObject([{
      id: 'custom.query',
      outputSchema: { type: 'string' },
    }]);
  });

  it('preserves advertised MCP output schemas', async () => {
    const advertisedOutputSchema = {
      type: 'object',
      properties: {
        records: { type: 'array', items: { type: 'object' } },
      },
    };
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: rpc.id,
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
        id: rpc.id,
        result: {
          tools: [{
            name: 'query',
            inputSchema: { type: 'object' },
            outputSchema: advertisedOutputSchema,
          }],
        },
      });
    });

    const source = new McpActionSource({
      mcpUrl: 'https://mcp.example.com',
      serviceName: 'custom',
      noAuth: true,
      fetch: fakeFetch,
    });

    await expect(source.listActions()).resolves.toMatchObject([{
      id: 'custom.query',
      outputSchema: advertisedOutputSchema,
    }]);
  });
});
