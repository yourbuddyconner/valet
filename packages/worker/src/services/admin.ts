import { encryptString } from '../lib/crypto.js';
import {
  setOrgApiKey,
  createInvite as dbCreateInvite,
  listUsers,
  updateUserRole,
  deleteUser,
  upsertCustomProvider,
} from '../lib/db.js';
import type { AppDb } from '../lib/drizzle.js';
import type { Invite, UserRole } from '@agent-ops/shared';

// ─── LLM Key Management ────────────────────────────────────────────────────

export async function setOrgLlmKey(
  db: AppDb,
  encryptionKey: string,
  params: { provider: string; key: string; setBy: string; models?: Array<{ id: string; name?: string }>; showAllModels?: boolean },
): Promise<void> {
  const encryptedKey = await encryptString(params.key, encryptionKey);
  await setOrgApiKey(db, {
    id: crypto.randomUUID(),
    provider: params.provider,
    encryptedKey,
    setBy: params.setBy,
    models: params.models ? JSON.stringify(params.models) : null,
    showAllModels: params.showAllModels,
  });
}

export async function updateOrgLlmKeyModelConfig(
  db: AppDb,
  params: { provider: string; models?: Array<{ id: string; name?: string }>; showAllModels?: boolean },
): Promise<void> {
  const { updateOrgApiKeyModelConfig } = await import('../lib/db.js');
  await updateOrgApiKeyModelConfig(db, params.provider, {
    models: params.models ? JSON.stringify(params.models) : null,
    showAllModels: params.showAllModels,
  });
}

// ─── Invite Management ──────────────────────────────────────────────────────

export async function createInvite(
  db: AppDb,
  params: { email?: string; role?: UserRole; invitedBy: string },
): Promise<Invite> {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const code = Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 12);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  return dbCreateInvite(db, {
    id: crypto.randomUUID(),
    code,
    email: params.email?.trim().toLowerCase(),
    role: params.role || 'member',
    invitedBy: params.invitedBy,
    expiresAt,
  });
}

// ─── User Role Management ───────────────────────────────────────────────────

export type UpdateRoleResult =
  | { ok: true }
  | { ok: false; error: 'last_admin' };

export async function updateUserRoleSafe(
  db: AppDb,
  userId: string,
  role: UserRole,
): Promise<UpdateRoleResult> {
  if (role === 'member') {
    const users = await listUsers(db);
    const adminCount = users.filter((u) => u.role === 'admin').length;
    const targetUser = users.find((u) => u.id === userId);
    if (targetUser?.role === 'admin' && adminCount <= 1) {
      return { ok: false, error: 'last_admin' };
    }
  }

  await updateUserRole(db, userId, role);
  return { ok: true };
}

// ─── User Deletion ──────────────────────────────────────────────────────────

export type DeleteUserResult =
  | { ok: true }
  | { ok: false; error: 'self_delete' | 'last_admin' };

export async function deleteUserSafe(
  db: AppDb,
  userId: string,
  requesterId: string,
): Promise<DeleteUserResult> {
  if (userId === requesterId) {
    return { ok: false, error: 'self_delete' };
  }

  const users = await listUsers(db);
  const targetUser = users.find((u) => u.id === userId);
  if (targetUser?.role === 'admin') {
    const adminCount = users.filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) {
      return { ok: false, error: 'last_admin' };
    }
  }

  await deleteUser(db, userId);
  return { ok: true };
}

// ─── Custom Provider Management ─────────────────────────────────────────────

export async function upsertCustomProviderWithEncryption(
  db: AppDb,
  encryptionKey: string,
  params: {
    providerId: string;
    displayName: string;
    baseUrl: string;
    apiKey?: string;
    models: string;
    showAllModels: boolean;
    setBy: string;
  },
): Promise<void> {
  let encryptedKey: string | null = null;
  if (params.apiKey && params.apiKey.trim().length > 0) {
    encryptedKey = await encryptString(params.apiKey, encryptionKey);
  }

  await upsertCustomProvider(db, {
    id: crypto.randomUUID(),
    providerId: params.providerId,
    displayName: params.displayName,
    baseUrl: params.baseUrl,
    encryptedKey,
    models: params.models,
    showAllModels: params.showAllModels,
    setBy: params.setBy,
  });
}
