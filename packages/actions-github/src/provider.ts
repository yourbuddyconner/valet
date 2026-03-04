import type { IntegrationProvider, IntegrationCredentials, OAuthConfig } from '@valet/sdk';
import { githubFetch } from './api.js';

export const githubProvider: IntegrationProvider = {
  service: 'github',
  displayName: 'GitHub',
  authType: 'oauth2',
  supportedEntities: ['repositories', 'issues', 'pull_requests', 'commits'],
  oauthScopes: ['repo', 'read:user', 'read:org'],
  oauthEnvKeys: { clientId: 'GITHUB_CLIENT_ID', clientSecret: 'GITHUB_CLIENT_SECRET' },

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!(credentials.access_token || credentials.token);
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const token = credentials.access_token || credentials.token || '';
      const res = await githubFetch('/user', token);
      return res.ok;
    } catch {
      return false;
    }
  },

  getOAuthUrl(oauth: OAuthConfig, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      scope: 'repo read:user read:org',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },

  async exchangeOAuthCode(
    oauth: OAuthConfig,
    code: string,
    redirectUri: string,
  ): Promise<IntegrationCredentials> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      throw new Error('Failed to exchange OAuth code');
    }

    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (data.error || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Failed to exchange OAuth code');
    }

    return {
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      scope: data.scope || '',
    };
  },
};
