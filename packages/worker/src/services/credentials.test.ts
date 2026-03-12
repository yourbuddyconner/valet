import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../env.js';

// Mock the DB layer
vi.mock('../lib/db/credentials.js', () => ({
  getCredentialRow: vi.fn(),
  upsertCredential: vi.fn(),
  deleteCredential: vi.fn(),
  listCredentialsByOwner: vi.fn(),
  hasCredential: vi.fn(),
}));

// Mock the crypto layer
vi.mock('../lib/crypto.js', () => ({
  encryptStringPBKDF2: vi.fn(),
  decryptStringPBKDF2: vi.fn(),
}));

// Mock the drizzle layer so we can verify getDb() return value is threaded through
const { fakeDrizzleDb } = vi.hoisted(() => {
  const fakeDrizzleDb = { __drizzle: true } as any;
  return { fakeDrizzleDb };
});
vi.mock('../lib/drizzle.js', () => ({
  getDb: vi.fn().mockReturnValue(fakeDrizzleDb),
}));

import * as credentialDb from '../lib/db/credentials.js';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import {
  getCredential,
  storeCredential,
  revokeCredential,
  listCredentials,
  hasCredential,
  resolveCredentials,
} from './credentials.js';

const mockDb = credentialDb as unknown as {
  getCredentialRow: ReturnType<typeof vi.fn>;
  upsertCredential: ReturnType<typeof vi.fn>;
  deleteCredential: ReturnType<typeof vi.fn>;
  listCredentialsByOwner: ReturnType<typeof vi.fn>;
  hasCredential: ReturnType<typeof vi.fn>;
  getExpiringCredentials: ReturnType<typeof vi.fn>;
};
const mockEncrypt = encryptStringPBKDF2 as ReturnType<typeof vi.fn>;
const mockDecrypt = decryptStringPBKDF2 as ReturnType<typeof vi.fn>;

const fakeEnv = {
  DB: {} as unknown,
  ENCRYPTION_KEY: 'test-key',
} as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCredential', () => {
  it('returns not_found when no row exists', async () => {
    mockDb.getCredentialRow.mockResolvedValue(null);

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('not_found');
      expect(result.error.service).toBe('github');
    }
  });

  it('decrypts and returns credential (happy path)', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'encrypted-blob',
      metadata: null,
      scopes: 'repo user',
      expiresAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockDecrypt.mockResolvedValue(JSON.stringify({ access_token: 'ghp_abc123' }));

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('ghp_abc123');
      expect(result.credential.credentialType).toBe('oauth2');
      expect(result.credential.scopes).toEqual(['repo', 'user']);
      expect(result.credential.refreshed).toBe(false);
    }
    expect(mockDecrypt).toHaveBeenCalledWith('encrypted-blob', 'test-key');
  });

  it('returns decryption_failed when decryption throws', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'bad-data',
      metadata: null,
      scopes: null,
      expiresAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockDecrypt.mockRejectedValue(new Error('decrypt failed'));

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('decryption_failed');
    }
  });

  it('returns decryption_failed when token field is missing', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'encrypted-blob',
      metadata: null,
      scopes: null,
      expiresAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    // No access_token, api_key, bot_token, or token field
    mockDecrypt.mockResolvedValue(JSON.stringify({ foo: 'bar' }));

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('decryption_failed');
      expect(result.error.message).toContain('missing token field');
    }
  });

  it('extracts api_key when access_token is absent', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'openai',
      credentialType: 'api_key',
      encryptedData: 'encrypted-blob',
      metadata: null,
      scopes: null,
      expiresAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockDecrypt.mockResolvedValue(JSON.stringify({ api_key: 'sk-abc123' }));

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'openai');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('sk-abc123');
    }
  });
});

describe('storeCredential', () => {
  it('encrypts and upserts', async () => {
    mockEncrypt.mockResolvedValue('encrypted-output');
    mockDb.upsertCredential.mockResolvedValue(undefined);

    await storeCredential(fakeEnv, 'user', 'user-1', 'github', { access_token: 'ghp_abc' }, {
      credentialType: 'oauth2',
      scopes: 'repo',
      expiresAt: '2026-01-01T00:00:00Z',
    });

    expect(mockEncrypt).toHaveBeenCalledWith(
      JSON.stringify({ access_token: 'ghp_abc' }),
      'test-key',
    );
    expect(mockDb.upsertCredential).toHaveBeenCalledWith(
      fakeDrizzleDb,
      expect.objectContaining({
        ownerType: 'user',
        ownerId: 'user-1',
        provider: 'github',
        credentialType: 'oauth2',
        encryptedData: 'encrypted-output',
        scopes: 'repo',
        expiresAt: '2026-01-01T00:00:00Z',
      }),
    );
  });

  it('defaults credentialType to api_key', async () => {
    mockEncrypt.mockResolvedValue('enc');
    mockDb.upsertCredential.mockResolvedValue(undefined);

    await storeCredential(fakeEnv, 'user', 'user-1', 'custom', { token: 'tok' });

    expect(mockDb.upsertCredential).toHaveBeenCalledWith(
      fakeDrizzleDb,
      expect.objectContaining({ credentialType: 'api_key' }),
    );
  });
});

describe('revokeCredential', () => {
  it('delegates to deleteCredential', async () => {
    mockDb.deleteCredential.mockResolvedValue(undefined);

    await revokeCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(mockDb.deleteCredential).toHaveBeenCalledWith(fakeDrizzleDb, 'user', 'user-1', 'github');
  });
});

describe('listCredentials', () => {
  it('transforms rows', async () => {
    mockDb.listCredentialsByOwner.mockResolvedValue([
      { provider: 'github', credentialType: 'oauth2', scopes: 'repo', expiresAt: null, createdAt: '2025-01-01', updatedAt: '2025-01-01' },
      { provider: 'google', credentialType: 'oauth2', scopes: null, expiresAt: '2026-01-01', createdAt: '2025-06-01', updatedAt: '2025-06-01' },
    ]);

    const result = await listCredentials(fakeEnv, 'user', 'user-1');

    expect(result).toHaveLength(2);
    expect(result[0].provider).toBe('github');
    expect(result[0].scopes).toBe('repo');
    expect(result[1].expiresAt).toBe('2026-01-01');
    // null scopes become undefined
    expect(result[1].scopes).toBeUndefined();
  });
});

describe('hasCredential', () => {
  it('delegates to DB hasCredential', async () => {
    mockDb.hasCredential.mockResolvedValue(true);

    const result = await hasCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result).toBe(true);
    expect(mockDb.hasCredential).toHaveBeenCalledWith(fakeDrizzleDb, 'user', 'user-1', 'github');
  });

  it('returns false when DB returns false', async () => {
    mockDb.hasCredential.mockResolvedValue(false);

    const result = await hasCredential(fakeEnv, 'user', 'user-1', 'nonexistent');

    expect(result).toBe(false);
  });
});

describe('resolveCredentials', () => {
  it('resolves multiple providers', async () => {
    mockDb.getCredentialRow.mockImplementation(async (_db: unknown, _ownerType: string, _ownerId: string, provider: string) => {
      if (provider === 'github') {
        return {
          id: 'cred-1', ownerType: 'user', ownerId: 'user-1', provider: 'github', credentialType: 'oauth2',
          encryptedData: 'enc-github', metadata: null, scopes: 'repo', expiresAt: null,
          createdAt: '2025-01-01', updatedAt: '2025-01-01',
        };
      }
      return null;
    });
    mockDecrypt.mockResolvedValue(JSON.stringify({ access_token: 'ghp_abc' }));

    const results = await resolveCredentials(fakeEnv, 'user', 'user-1', ['github', 'slack']);

    expect(results.size).toBe(2);

    const github = results.get('github')!;
    expect(github.ok).toBe(true);

    const slack = results.get('slack')!;
    expect(slack.ok).toBe(false);
    if (!slack.ok) {
      expect(slack.error.reason).toBe('not_found');
    }
  });
});
