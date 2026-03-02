import type { IntegrationProvider, IntegrationCredentials, OAuthConfig } from '@agent-ops/sdk';

export const notionProvider: IntegrationProvider = {
  service: 'notion',
  displayName: 'Notion',
  authType: 'oauth2',
  supportedEntities: ['pages', 'databases', 'blocks'],
  oauthScopes: [],
  oauthEnvKeys: { clientId: 'NOTION_CLIENT_ID', clientSecret: 'NOTION_CLIENT_SECRET' },

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await fetch('https://api.notion.com/v1/users/me', {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          'Notion-Version': '2022-06-28',
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  getOAuthUrl(oauth: OAuthConfig, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      owner: 'user',
      state,
    });
    return `https://api.notion.com/v1/oauth/authorize?${params}`;
  },

  async exchangeOAuthCode(
    oauth: OAuthConfig,
    code: string,
    redirectUri: string,
  ): Promise<IntegrationCredentials> {
    // Notion uses Basic auth (base64(clientId:clientSecret)) for token exchange
    const basicAuth = btoa(`${oauth.clientId}:${oauth.clientSecret}`);

    const res = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Notion OAuth token exchange failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      workspace_id?: string;
      workspace_name?: string;
      error?: string;
    };

    if (data.error || !data.access_token) {
      throw new Error(data.error || 'Failed to exchange Notion OAuth code');
    }

    return {
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      workspace_id: data.workspace_id || '',
    };
  },

  // Notion access tokens are non-expiring; refresh is not supported.
};
