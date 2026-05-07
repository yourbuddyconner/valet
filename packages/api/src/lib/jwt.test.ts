import { describe, it, expect } from 'vitest';
import { deriveSandboxJwtSecret, signJWT, verifyJWT } from './jwt.js';

const ENCRYPTION_KEY = 'test-encryption-key-must-not-leak-to-sandbox';

describe('deriveSandboxJwtSecret', () => {
  it('is deterministic for the same session', async () => {
    const a = await deriveSandboxJwtSecret(ENCRYPTION_KEY, 'session-1');
    const b = await deriveSandboxJwtSecret(ENCRYPTION_KEY, 'session-1');
    expect(a).toBe(b);
  });

  it('produces different keys for different sessions', async () => {
    const a = await deriveSandboxJwtSecret(ENCRYPTION_KEY, 'session-1');
    const b = await deriveSandboxJwtSecret(ENCRYPTION_KEY, 'session-2');
    expect(a).not.toBe(b);
  });

  it('does not equal the encryption key', async () => {
    const derived = await deriveSandboxJwtSecret(ENCRYPTION_KEY, 'session-1');
    expect(derived).not.toBe(ENCRYPTION_KEY);
    expect(derived).not.toContain(ENCRYPTION_KEY);
  });

  it('returns a 64-char hex string (32 bytes HMAC-SHA256)', async () => {
    const derived = await deriveSandboxJwtSecret(ENCRYPTION_KEY, 'session-1');
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs a JWT that verifies under the same derived key', async () => {
    const sessionId = 'sess-abc';
    const secret = await deriveSandboxJwtSecret(ENCRYPTION_KEY, sessionId);
    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT(
      { sub: 'user-1', sid: sessionId, iat: now, exp: now + 60 },
      secret,
    );
    const payload = await verifyJWT(token, secret);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.sid).toBe(sessionId);
  });

  it('does not verify under a different session key (cross-session isolation)', async () => {
    const secretA = await deriveSandboxJwtSecret(ENCRYPTION_KEY, 'session-a');
    const secretB = await deriveSandboxJwtSecret(ENCRYPTION_KEY, 'session-b');
    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT(
      { sub: 'user-1', sid: 'session-a', iat: now, exp: now + 60 },
      secretA,
    );
    const payload = await verifyJWT(token, secretB);
    expect(payload).toBeNull();
  });

  it('does not verify under the raw encryption key', async () => {
    const sessionId = 'sess-abc';
    const secret = await deriveSandboxJwtSecret(ENCRYPTION_KEY, sessionId);
    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT(
      { sub: 'user-1', sid: sessionId, iat: now, exp: now + 60 },
      secret,
    );
    const payload = await verifyJWT(token, ENCRYPTION_KEY);
    expect(payload).toBeNull();
  });
});
