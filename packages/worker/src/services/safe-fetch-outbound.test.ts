import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSafeFetchOutbound,
  safeFetchOutbound,
} from './safe-fetch-outbound.js';

describe('safeFetchOutbound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forces manual redirects and rejects redirects for MCP and OAuth token requests', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://mcp.example.com/next' },
    }));
    const fetchFn = createSafeFetchOutbound({ fetch: fetchMock });

    await expect(fetchFn('https://mcp.example.com/rpc', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    })).rejects.toThrow(/redirect/i);

    expect(fetchMock).toHaveBeenCalledWith('https://mcp.example.com/rpc', expect.objectContaining({
      redirect: 'manual',
    }));
  });

  it('follows discovery redirects only through policy-approved targets', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://auth.example.com/.well-known/oauth-authorization-server' },
      }))
      .mockResolvedValueOnce(Response.json({ issuer: 'https://auth.example.com' }));

    const res = await safeFetchOutbound('https://mcp.example.com/.well-known/oauth-authorization-server', {}, {
      mode: 'discovery',
      fetch: fetchMock,
    });

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
  });

  it('does not forward sensitive headers to a different origin during discovery redirects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://auth.example.com/metadata' },
      }))
      .mockResolvedValueOnce(Response.json({ issuer: 'https://auth.example.com' }));

    await safeFetchOutbound('https://mcp.example.com/metadata', {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'sid=secret',
        'X-Tenant': 'acme',
      },
    }, {
      mode: 'discovery',
      fetch: fetchMock,
    });

    const redirectedInit = fetchMock.mock.calls[1][1] as RequestInit;
    const redirectedHeaders = new Headers(redirectedInit.headers);
    expect(redirectedHeaders.has('Authorization')).toBe(false);
    expect(redirectedHeaders.has('Cookie')).toBe(false);
    expect(redirectedHeaders.has('X-Tenant')).toBe(false);
  });

  it('returns large MCP responses without applying a response-size cap', async () => {
    const body = 'x'.repeat(128 * 1024);
    const fetchMock = vi.fn(async () => new Response(body));

    const res = await safeFetchOutbound('https://mcp.example.com/rpc', {}, {
      fetch: fetchMock,
    });

    await expect(res.text()).resolves.toHaveLength(body.length);
  });

  it('keeps the timeout active until the returned response body finishes', async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          signal.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      }));
    });

    const responsePromise = safeFetchOutbound('https://mcp.example.com/rpc', {}, {
      fetch: fetchMock,
      timeoutMs: 10,
    });
    try {
      const res = await Promise.race([
        responsePromise,
        delay(50).then(() => {
          throw new Error('safeFetchOutbound did not return before the response body completed');
        }),
      ]);
      const readResult = res.text().then(
        () => 'resolved',
        () => 'rejected',
      );

      await delay(25);
      await expect(Promise.race([readResult, Promise.resolve('pending')])).resolves.toBe('rejected');
    } finally {
      try {
        bodyController?.close();
      } catch {
        // Stream may already be errored by the timeout.
      }
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
