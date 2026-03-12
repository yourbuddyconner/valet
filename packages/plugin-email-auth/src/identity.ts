import type { IdentityProvider, ProviderConfig, CallbackData, IdentityResult } from '@valet/sdk/identity';

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:100000:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, iterStr, saltHex, hashHex] = stored.split(':');
  const iterations = parseInt(iterStr, 10);
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computedHex === hashHex;
}

export const emailIdentityProvider: IdentityProvider = {
  id: 'email',
  displayName: 'Email',
  icon: 'key',
  protocol: 'credentials',
  configKeys: [],

  async handleCallback(_config: ProviderConfig, data: CallbackData): Promise<IdentityResult> {
    if (!data.email || !data.password) {
      throw new Error('Email and password are required');
    }
    return {
      externalId: data.email.toLowerCase(),
      email: data.email.toLowerCase(),
    };
  },
};

export { hashPassword, verifyPassword };
