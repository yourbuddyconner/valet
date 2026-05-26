// ─── MCP OAuth: RFC 8414 Discovery, RFC 7591 Dynamic Registration, RFC 7636 PKCE ───

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

// ─── RFC 9728 + RFC 8414: Authorization Server Metadata Discovery ───────────

interface ProtectedResourceMetadata {
  authorization_servers?: string[];
}

/**
 * Discover authorization server metadata from an MCP server URL.
 *
 * Tries two strategies:
 * 1. RFC 9728 — fetch protected resource metadata at the origin to find the
 *    authorization server, then fetch its metadata.
 * 2. RFC 8414 fallback — fetch oauth-authorization-server metadata directly
 *    at the origin.
 *
 * Previous code appended .well-known to the full server URL path, which fails
 * for servers like Salesforce where discovery lives at the origin.
 */
export async function discoverAuthServer(mcpServerUrl: string, opts?: { fetch?: typeof fetch }): Promise<AuthServerMetadata> {
  const origin = new URL(mcpServerUrl).origin;
  const fetcher = opts?.fetch ?? fetch;

  // RFC 9728: protected resource metadata → authorization server metadata
  try {
    const prmRes = await fetcher(`${origin}/.well-known/oauth-protected-resource`);
    if (prmRes.ok) {
      const prm = (await prmRes.json()) as ProtectedResourceMetadata;
      const authServerUrl = prm.authorization_servers?.[0]?.replace(/\/+$/, '');
      if (authServerUrl) {
        const asRes = await fetcher(`${authServerUrl}/.well-known/oauth-authorization-server`);
        if (asRes.ok) return (await asRes.json()) as AuthServerMetadata;
      }
    }
  } catch { /* fall through to direct discovery */ }

  // RFC 8414 fallback: direct auth server metadata at origin
  const res = await fetcher(`${origin}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new Error(`MCP OAuth discovery failed: ${res.status} from ${origin}`);
  }
  return (await res.json()) as AuthServerMetadata;
}

// ─── RFC 7591: Dynamic Client Registration ──────────────────────────────────

/** Register a dynamic OAuth client with the authorization server. */
export async function registerClient(
  registrationEndpoint: string,
  params: { clientName: string; redirectUris: string[]; fetch?: typeof fetch },
): Promise<RegisteredClient> {
  const res = await (params.fetch ?? fetch)(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: params.clientName,
      redirect_uris: params.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP client registration failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as RegisteredClient;
}

// ─── RFC 7636: PKCE (S256) ──────────────────────────────────────────────────

/** Generate a PKCE code_verifier and code_challenge (S256). */
export async function generatePkceChallenge(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const codeVerifier = base64UrlEncode(bytes);

  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));

  return { codeVerifier, codeChallenge };
}

/** Build an authorization URL with PKCE parameters. */
export function buildAuthorizationUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: string[];
  /** MCP resource server URL (RFC 8707). Scopes the token to this resource. */
  resource?: string;
}): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  if (params.scopes?.length) {
    url.searchParams.set('scope', params.scopes.join(' '));
  }
  if (params.resource) {
    url.searchParams.set('resource', params.resource);
  }
  return url.toString();
}

// ─── Token Exchange & Refresh (Public Client, PKCE) ─────────────────────────

/** Exchange authorization code for tokens using PKCE (public client, no client_secret). */
export async function exchangeCodePkce(params: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** MCP resource server URL (RFC 8707). Must match the value sent in the authorization request. */
  resource?: string;
  fetch?: typeof fetch;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  if (params.resource) {
    body.set('resource', params.resource);
  }
  const res = await (params.fetch ?? fetch)(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP PKCE token exchange failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Exchange authorization code for tokens using PKCE and admin-provided client credentials. */
export async function exchangeCodeWithClientCredentials(params: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** MCP resource server URL (RFC 8707). Must match the value sent in the authorization request. */
  resource?: string;
  fetch?: typeof fetch;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  if (params.resource) {
    body.set('resource', params.resource);
  }

  const headers = buildTokenRequestAuth(params.clientId, params.clientSecret, params.tokenEndpointAuthMethod ?? 'none', body);
  const res = await (params.fetch ?? fetch)(params.tokenEndpoint, {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP client-credentials token exchange failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Refresh a token for a public client. */
export async function refreshTokenPkce(params: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  fetch?: typeof fetch;
}): Promise<TokenResponse> {
  const res = await (params.fetch ?? fetch)(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: params.clientId,
      refresh_token: params.refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP PKCE token refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Refresh a token using admin-provided client credentials. */
export async function refreshTokenWithClientCredentials(params: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  refreshToken: string;
  /** MCP resource server URL (RFC 8707). */
  resource?: string;
  fetch?: typeof fetch;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  });
  if (params.resource) {
    body.set('resource', params.resource);
  }

  const headers = buildTokenRequestAuth(params.clientId, params.clientSecret, params.tokenEndpointAuthMethod ?? 'none', body);
  const res = await (params.fetch ?? fetch)(params.tokenEndpoint, {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP client-credentials token refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildTokenRequestAuth(
  clientId: string,
  clientSecret: string | undefined,
  method: TokenEndpointAuthMethod,
  body: URLSearchParams,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (!clientSecret || method === 'none') {
    return headers;
  }

  if (method === 'client_secret_basic') {
    headers.Authorization = `Basic ${btoa(`${formEncodeComponent(clientId)}:${formEncodeComponent(clientSecret)}`)}`;
    return headers;
  }

  body.set('client_secret', clientSecret);
  return headers;
}

function formEncodeComponent(value: string): string {
  const params = new URLSearchParams([['value', value]]);
  return params.toString().slice('value='.length);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
