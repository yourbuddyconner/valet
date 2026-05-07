/**
 * AES-256-GCM encryption/decryption using Web Crypto API.
 * IV is prepended to the ciphertext and the result is base64-encoded.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveKey(secret: string): Promise<CryptoKey> {
  const keyData = encoder.encode(secret.padEnd(32, '0').slice(0, 32));
  return crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptString(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );

  // Prepend IV to ciphertext
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  // Base64 encode
  let binary = '';
  for (const byte of combined) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function decryptString(ciphertext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);

  // Base64 decode
  const binary = atob(ciphertext);
  const combined = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    combined[i] = binary.charCodeAt(i);
  }

  // Extract IV (first 12 bytes) and encrypted data
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return decoder.decode(decrypted);
}

// --- PBKDF2-based encryption (used by unified credentials table) ---

const PBKDF2_SALT = encoder.encode('agent-ops-credentials');
const PBKDF2_ITERATIONS = 100_000;

let cachedPBKDF2Key: { secret: string; key: CryptoKey } | null = null;

async function deriveKeyPBKDF2(secret: string): Promise<CryptoKey> {
  if (cachedPBKDF2Key && cachedPBKDF2Key.secret === secret) {
    return cachedPBKDF2Key.key;
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: PBKDF2_SALT, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  cachedPBKDF2Key = { secret, key };
  return key;
}

export async function encryptStringPBKDF2(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKeyPBKDF2(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  let binary = '';
  for (const byte of combined) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function decryptStringPBKDF2(ciphertext: string, secret: string): Promise<string> {
  const key = await deriveKeyPBKDF2(secret);

  const binary = atob(ciphertext);
  const combined = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    combined[i] = binary.charCodeAt(i);
  }

  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return decoder.decode(decrypted);
}
