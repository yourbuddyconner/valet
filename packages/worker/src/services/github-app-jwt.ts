/**
 * Mint a short-lived JWT for authenticating as a GitHub App.
 * Uses RSA-PKCS1-v1_5 with SHA-256, signed with the app's private key.
 */
export async function mintGitHubAppJWT(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string) =>
    btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 10 * 60, iss: appId }),
  );

  const pemBody = privateKeyPem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemBody), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${header}.${payload}.${sig}`;
}

/**
 * Mint a short-lived installation access token for a GitHub App installation.
 * Uses the App JWT to call POST /app/installations/{id}/access_tokens.
 */
export async function mintGitHubInstallationToken(
  installationId: string,
  appId: string,
  privateKeyPem: string,
): Promise<{ token: string; expiresAt: string }> {
  const jwt = await mintGitHubAppJWT(appId, privateKeyPem);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Valet-App',
      },
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API returned ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}
