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

// ─── RFC 8414: Authorization Server Metadata Discovery ──────────────────────

/** Discover authorization server metadata from an MCP server URL. */
export async function discoverAuthServer(mcpServerUrl: string): Promise<AuthServerMetadata> {
  const base = mcpServerUrl.replace(/\/+$/, '');
  const url = `${base}/.well-known/oauth-authorization-server`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`MCP OAuth discovery failed: ${res.status} from ${url}`);
  }
  return (await res.json()) as AuthServerMetadata;
}

// ─── RFC 7591: Dynamic Client Registration ──────────────────────────────────

/** Register a dynamic OAuth client with the authorization server. */
export async function registerClient(
  registrationEndpoint: string,
  params: { clientName: string; redirectUris: string[] },
): Promise<RegisteredClient> {
  const res = await fetch(registrationEndpoint, {
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
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  if (params.scopes?.length) {
    query.set('scope', params.scopes.join(' '));
  }
  return `${params.authorizationEndpoint}?${query}`;
}

// ─── Token Exchange & Refresh (Public Client, PKCE) ─────────────────────────

/** Exchange authorization code for tokens using PKCE (public client, no client_secret). */
export async function exchangeCodePkce(params: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const res = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: params.clientId,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP PKCE token exchange failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Refresh a token for a public client. */
export async function refreshTokenPkce(params: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const res = await fetch(params.tokenEndpoint, {
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
