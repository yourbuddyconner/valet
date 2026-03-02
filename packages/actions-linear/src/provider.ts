import type { IntegrationProvider, IntegrationCredentials, OAuthConfig } from '@agent-ops/sdk';

export const linearProvider: IntegrationProvider = {
  service: 'linear',
  displayName: 'Linear',
  authType: 'oauth2',
  supportedEntities: ['issues', 'projects', 'teams', 'comments'],
  oauthScopes: ['read', 'write'],
  oauthEnvKeys: { clientId: 'LINEAR_CLIENT_ID', clientSecret: 'LINEAR_CLIENT_SECRET' },

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.access_token}`,
        },
        body: JSON.stringify({ query: '{ viewer { id } }' }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { data?: { viewer?: { id: string } } };
      return !!data.data?.viewer?.id;
    } catch {
      return false;
    }
  },

  getOAuthUrl(oauth: OAuthConfig, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'read,write',
      state,
    });
    return `https://linear.app/oauth/authorize?${params}`;
  },

  async exchangeOAuthCode(
    oauth: OAuthConfig,
    code: string,
    redirectUri: string,
  ): Promise<IntegrationCredentials> {
    const res = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Linear OAuth token exchange failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (data.error || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Failed to exchange Linear OAuth code');
    }

    return {
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      scope: data.scope || '',
    };
  },

  async refreshOAuthTokens(
    oauth: OAuthConfig,
    refreshToken: string,
  ): Promise<IntegrationCredentials> {
    const res = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      throw new Error(`Linear token refresh failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
    };

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      token_type: data.token_type || 'bearer',
    };
  },
};
