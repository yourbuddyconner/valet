import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizationUrl,
  exchangeCodeWithClientCredentials,
  refreshTokenPkce,
  refreshTokenWithClientCredentials,
} from './oauth.js';

async function readForm(init?: RequestInit): Promise<URLSearchParams> {
  return init?.body as URLSearchParams;
}

describe('MCP OAuth helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds PKCE authorization URLs with S256 and resource without leaking the verifier', () => {
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: 'https://login.salesforce.com/services/oauth2/authorize',
      clientId: 'client-123',
      redirectUri: 'https://app.example.com/integrations/callback',
      codeChallenge: 'challenge-abc',
      state: 'state-123',
      scopes: ['mcp_api', 'refresh_token'],
      resource: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all',
    }));

    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('scope')).toBe('mcp_api refresh_token');
    expect(url.searchParams.get('resource')).toBe('https://api.salesforce.com/platform/mcp/v1/platform/sobject-all');
    expect(url.searchParams.has('code_verifier')).toBe(false);
  });

  it('exchanges codes with client_secret_basic and matching resource', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = await readForm(init);
      expect(init?.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa('client-123:secret-456')}`,
      });
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('client_id')).toBe('client-123');
      expect(form.get('client_secret')).toBeNull();
      expect(form.get('code_verifier')).toBe('verifier-789');
      expect(form.get('resource')).toBe('https://api.salesforce.com/platform/mcp/v1/platform/sobject-all');
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeCodeWithClientCredentials({
      tokenEndpoint: 'https://login.salesforce.com/services/oauth2/token',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      tokenEndpointAuthMethod: 'client_secret_basic',
      code: 'code-abc',
      redirectUri: 'https://app.example.com/integrations/callback',
      codeVerifier: 'verifier-789',
      resource: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all',
    })).resolves.toMatchObject({ access_token: 'access', refresh_token: 'refresh' });
  });

  it('form-encodes client credentials before building client_secret_basic auth', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${btoa('client%3A123:s%C3%ABcret%2B456')}`,
      });
      return new Response(JSON.stringify({ access_token: 'access' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await exchangeCodeWithClientCredentials({
      tokenEndpoint: 'https://login.example.com/token',
      clientId: 'client:123',
      clientSecret: 'sëcret+456',
      tokenEndpointAuthMethod: 'client_secret_basic',
      code: 'code-abc',
      redirectUri: 'https://app.example.com/integrations/callback',
      codeVerifier: 'verifier-789',
      fetch: fetchMock,
    });
  });

  it('exchanges and refreshes with client_secret_post', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = await readForm(init);
      expect(init?.headers).not.toHaveProperty('Authorization');
      expect(form.get('client_id')).toBe('client-123');
      expect(form.get('client_secret')).toBe('secret-456');
      return new Response(JSON.stringify({ access_token: 'access' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await exchangeCodeWithClientCredentials({
      tokenEndpoint: 'https://example.com/token',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      tokenEndpointAuthMethod: 'client_secret_post',
      code: 'code-abc',
      redirectUri: 'https://app.example.com/integrations/callback',
      codeVerifier: 'verifier-789',
    });

    await refreshTokenWithClientCredentials({
      tokenEndpoint: 'https://example.com/token',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      tokenEndpointAuthMethod: 'client_secret_post',
      refreshToken: 'refresh-123',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('omits client secrets for public PKCE refreshes', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = await readForm(init);
      expect(init?.headers).not.toHaveProperty('Authorization');
      expect(form.get('client_id')).toBe('client-123');
      expect(form.get('client_secret')).toBeNull();
      expect(form.get('resource')).toBe('https://mcp.example.com');
      return new Response(JSON.stringify({ access_token: 'access' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await refreshTokenWithClientCredentials({
      tokenEndpoint: 'https://example.com/token',
      clientId: 'client-123',
      tokenEndpointAuthMethod: 'none',
      refreshToken: 'refresh-123',
      resource: 'https://mcp.example.com',
    });
  });

  it('includes matching resource for public PKCE refreshes', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = await readForm(init);
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('client_id')).toBe('client-123');
      expect(form.get('refresh_token')).toBe('refresh-123');
      expect(form.get('resource')).toBe('https://mcp.example.com/mcp');
      return new Response(JSON.stringify({ access_token: 'access' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await refreshTokenPkce({
      tokenEndpoint: 'https://example.com/token',
      clientId: 'client-123',
      refreshToken: 'refresh-123',
      resource: 'https://mcp.example.com/mcp',
      fetch: fetchMock,
    });
  });

  it('uses injected fetch for client-credential exchange and refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('global fetch should not be used');
    }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'access' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await exchangeCodeWithClientCredentials({
      tokenEndpoint: 'https://example.com/token',
      clientId: 'client-123',
      tokenEndpointAuthMethod: 'none',
      code: 'code-abc',
      redirectUri: 'https://app.example.com/integrations/callback',
      codeVerifier: 'verifier-789',
      fetch: fetchMock,
    });

    await refreshTokenWithClientCredentials({
      tokenEndpoint: 'https://example.com/token',
      clientId: 'client-123',
      tokenEndpointAuthMethod: 'none',
      refreshToken: 'refresh-123',
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
