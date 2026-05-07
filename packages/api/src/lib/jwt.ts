/**
 * Minimal JWT signing/verification using Web Crypto API (HMAC-SHA256).
 * No external dependencies — runs natively in Cloudflare Workers.
 */

function base64UrlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const encoder = new TextEncoder();

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Derive a per-session JWT signing key from the worker's encryption key.
 *
 * The sandbox only needs an HMAC key to verify client JWTs and mint tunnel
 * tokens — it does not need the raw `ENCRYPTION_KEY` (which also unlocks all
 * org credential storage). Deriving a deterministic per-session key via
 * HMAC-SHA256 keeps the sandbox compatible with the existing gateway (same
 * algorithm) while ensuring a compromised sandbox cannot decrypt any stored
 * credentials or forge tokens for other sessions.
 */
export async function deriveSandboxJwtSecret(
  encryptionKey: string,
  sessionId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(sessionId));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface SandboxJWTPayload {
  sub: string; // userId
  sid: string; // sessionId
  exp: number; // expiry (unix seconds)
  iat: number; // issued at (unix seconds)
}

/**
 * Sign a JWT with HMAC-SHA256.
 */
export async function signJWT(payload: SandboxJWTPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));

  const signatureB64 = base64UrlEncode(new Uint8Array(signature));
  return `${signingInput}.${signatureB64}`;
}

/**
 * Verify and decode a JWT signed with HMAC-SHA256.
 * Returns null if invalid or expired.
 */
export async function verifyJWT(token: string, secret: string): Promise<SandboxJWTPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getKey(secret);
  const signature = base64UrlDecode(signatureB64);

  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signingInput));
  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as SandboxJWTPayload;

  // Check expiry
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}
