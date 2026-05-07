import { describe, it, expect } from 'vitest';
import {
  encryptString,
  decryptString,
  encryptStringPBKDF2,
  decryptStringPBKDF2,
} from './crypto.js';

const TEST_SECRET = 'test-encryption-key-for-unit-tests';

describe('AES-GCM (direct key)', () => {
  it('round-trips plaintext', async () => {
    const plaintext = 'hello world';
    const encrypted = await encryptString(plaintext, TEST_SECRET);
    const decrypted = await decryptString(encrypted, TEST_SECRET);
    expect(decrypted).toBe(plaintext);
  });

  it('rejects wrong key', async () => {
    const encrypted = await encryptString('secret', TEST_SECRET);
    await expect(decryptString(encrypted, 'wrong-key')).rejects.toThrow();
  });

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const plaintext = 'same input';
    const a = await encryptString(plaintext, TEST_SECRET);
    const b = await encryptString(plaintext, TEST_SECRET);
    expect(a).not.toBe(b);
  });

  it('handles empty string', async () => {
    const encrypted = await encryptString('', TEST_SECRET);
    const decrypted = await decryptString(encrypted, TEST_SECRET);
    expect(decrypted).toBe('');
  });

  it('handles unicode', async () => {
    const plaintext = '你好世界 🌍 émojis café';
    const encrypted = await encryptString(plaintext, TEST_SECRET);
    const decrypted = await decryptString(encrypted, TEST_SECRET);
    expect(decrypted).toBe(plaintext);
  });
});

describe('AES-GCM (PBKDF2 key derivation)', () => {
  it('round-trips plaintext', async () => {
    const plaintext = 'hello world';
    const encrypted = await encryptStringPBKDF2(plaintext, TEST_SECRET);
    const decrypted = await decryptStringPBKDF2(encrypted, TEST_SECRET);
    expect(decrypted).toBe(plaintext);
  });

  it('rejects wrong key', async () => {
    const encrypted = await encryptStringPBKDF2('secret', TEST_SECRET);
    await expect(decryptStringPBKDF2(encrypted, 'wrong-key')).rejects.toThrow();
  });

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const plaintext = 'same input';
    const a = await encryptStringPBKDF2(plaintext, TEST_SECRET);
    const b = await encryptStringPBKDF2(plaintext, TEST_SECRET);
    expect(a).not.toBe(b);
  });

  it('handles empty string', async () => {
    const encrypted = await encryptStringPBKDF2('', TEST_SECRET);
    const decrypted = await decryptStringPBKDF2(encrypted, TEST_SECRET);
    expect(decrypted).toBe('');
  });

  it('handles unicode', async () => {
    const plaintext = '你好世界 🌍 émojis café';
    const encrypted = await encryptStringPBKDF2(plaintext, TEST_SECRET);
    const decrypted = await decryptStringPBKDF2(encrypted, TEST_SECRET);
    expect(decrypted).toBe(plaintext);
  });
});

describe('cross-scheme isolation', () => {
  it('PBKDF2 ciphertext cannot be decrypted with direct-key function', async () => {
    const encrypted = await encryptStringPBKDF2('secret', TEST_SECRET);
    await expect(decryptString(encrypted, TEST_SECRET)).rejects.toThrow();
  });

  it('direct-key ciphertext cannot be decrypted with PBKDF2 function', async () => {
    const encrypted = await encryptString('secret', TEST_SECRET);
    await expect(decryptStringPBKDF2(encrypted, TEST_SECRET)).rejects.toThrow();
  });
});
