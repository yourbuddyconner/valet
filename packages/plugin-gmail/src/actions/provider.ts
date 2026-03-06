import type { IntegrationProvider, IntegrationCredentials, OAuthConfig } from '@valet/sdk';
import { gmailFetch } from './api.js';

const GOOGLE_OAUTH = 'https://oauth2.googleapis.com';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
];

export const gmailProvider: IntegrationProvider = {
  service: 'gmail',
  displayName: 'Gmail',
  authType: 'oauth2',
  supportedEntities: ['messages', 'threads', 'labels', 'drafts'],
  oauthScopes: GMAIL_SCOPES,
  oauthEnvKeys: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!(credentials.access_token || credentials.refresh_token);
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const token = credentials.access_token || '';
      const res = await gmailFetch('/users/me/profile', token);
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
      scope: GMAIL_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${GOOGLE_AUTH}?${params}`;
  },

  async exchangeOAuthCode(
    oauth: OAuthConfig,
    code: string,
    redirectUri: string,
  ): Promise<IntegrationCredentials> {
    const res = await fetch(`${GOOGLE_OAUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to exchange OAuth code: ${error}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
      scope: string;
    };

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || '',
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
      scope: data.scope,
    };
  },

  async refreshOAuthTokens(
    oauth: OAuthConfig,
    refreshToken: string,
  ): Promise<IntegrationCredentials> {
    const res = await fetch(`${GOOGLE_OAUTH}/token`, {
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
      throw new Error('Failed to refresh OAuth tokens');
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };

    return {
      access_token: data.access_token,
      refresh_token: refreshToken,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
    };
  },
};
