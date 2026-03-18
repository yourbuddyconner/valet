/**
 * Shared utilities for GitHub repo providers (OAuth + App).
 */
import type { RepoCredential, RepoValidation } from '@valet/sdk/repos';
import { githubFetch } from './actions/api.js';

// ─── URL Patterns ────────────────────────────────────────────────────────────

export const GITHUB_URL_PATTERNS: RegExp[] = [/github\.com/];

// ─── Internal Helpers ────────────────────────────────────────────────────────

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64url(data: ArrayBuffer | Uint8Array | string): string {
  let b64: string;
  if (typeof data === 'string') {
    b64 = btoa(data);
  } else {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    b64 = btoa(String.fromCharCode(...bytes));
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Exported Utilities ──────────────────────────────────────────────────────

export async function mintInstallationToken(
  installationId: string,
  appId: string,
  privateKey: string,
): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const jwt = `${header}.${payload}.${base64url(signature)}`;

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Valet',
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to mint installation token: ${res.status}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

export function mapGitHubRepo(r: any) {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    url: r.html_url,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    private: r.private,
    description: r.description ?? null,
    updatedAt: r.updated_at,
    language: r.language ?? null,
  };
}

export async function validateGitHubRepo(
  credential: RepoCredential,
  repoUrl: string,
): Promise<RepoValidation> {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return { accessible: false, error: 'Invalid GitHub URL' };
  const [, owner, repo] = match;
  if (!credential.accessToken) {
    return { accessible: false, error: 'No access token available — mint a token first' };
  }
  const res = await githubFetch(`/repos/${owner}/${repo}`, credential.accessToken);
  if (!res.ok) return { accessible: false, error: `Repository not accessible: ${res.status}` };
  const data = (await res.json()) as {
    full_name: string;
    default_branch: string;
    private: boolean;
    clone_url: string;
    permissions?: { push: boolean; pull: boolean; admin: boolean };
  };
  return {
    accessible: true,
    permissions: data.permissions || { push: false, pull: true, admin: false },
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: data.private,
    cloneUrl: data.clone_url,
  };
}
