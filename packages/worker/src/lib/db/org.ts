import type { D1Database } from '@cloudflare/workers-types';
import type { AppDb } from '../drizzle.js';
import type { OrgSettings, OrgApiKey, Invite, UserRole, OrgRepository, OrchestratorIdentity, CustomProvider, CustomProviderModel } from '@valet/shared';
import { eq, and, isNull, gt, sql, desc, asc } from 'drizzle-orm';
import { toDate } from '../drizzle.js';
import { orgSettings, orgApiKeys, invites, orgRepositories, customProviders, modelCatalogCache } from '../schema/index.js';
import { orchestratorIdentities } from '../schema/orchestrator.js';

function rowToOrgSettings(row: typeof orgSettings.$inferSelect): OrgSettings {
  return {
    id: row.id!,
    name: row.name,
    allowedEmailDomain: row.allowedEmailDomain || undefined,
    allowedEmails: row.allowedEmails || undefined,
    domainGatingEnabled: !!row.domainGatingEnabled,
    emailAllowlistEnabled: !!row.emailAllowlistEnabled,
    defaultSessionVisibility: (row.defaultSessionVisibility as OrgSettings['defaultSessionVisibility']) || 'private',
    modelPreferences: row.modelPreferences || undefined,
    enabledLoginProviders: row.enabledLoginProviders || undefined,
    driveLabelsGuardEnabled: Boolean(row.driveLabelsGuardEnabled),
    driveRequiredLabelIds: JSON.parse(row.driveRequiredLabelIds || '[]') as string[],
    driveLabelsFailMode: (row.driveLabelsFailMode || 'deny') as 'deny' | 'allow',
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function rowToInvite(row: typeof invites.$inferSelect): Invite {
  return {
    id: row.id,
    code: row.code,
    email: row.email || undefined,
    role: row.role as UserRole,
    invitedBy: row.invitedBy,
    acceptedAt: row.acceptedAt ? toDate(row.acceptedAt) : undefined,
    acceptedBy: row.acceptedBy || undefined,
    expiresAt: toDate(row.expiresAt),
    createdAt: toDate(row.createdAt),
  };
}

function rowToOrgRepository(row: any): OrgRepository {
  return {
    id: row.id,
    orgId: row.orgId || row.org_id,
    provider: row.provider,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName || row.full_name,
    description: row.description || undefined,
    defaultBranch: row.defaultBranch || row.default_branch || 'main',
    language: row.language || undefined,
    topics: row.topics ? (typeof row.topics === 'string' ? JSON.parse(row.topics) : row.topics) : undefined,
    enabled: row.enabled !== undefined ? !!row.enabled : true,
    personaId: row.personaId || row.persona_id || undefined,
    personaName: row.personaName || row.persona_name || undefined,
    createdAt: row.createdAt || row.created_at,
    updatedAt: row.updatedAt || row.updated_at,
  };
}

// Org settings operations
export async function getOrgSettings(db: AppDb): Promise<OrgSettings> {
  const row = await db.select().from(orgSettings).where(eq(orgSettings.id, 'default')).get();
  if (!row) {
    return {
      id: 'default',
      name: 'My Organization',
      domainGatingEnabled: false,
      emailAllowlistEnabled: false,
      defaultSessionVisibility: 'private',
      driveLabelsGuardEnabled: false,
      driveRequiredLabelIds: [],
      driveLabelsFailMode: 'deny' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
  return rowToOrgSettings(row);
}

export async function updateOrgSettings(
  db: AppDb,
  updates: Partial<Pick<OrgSettings, 'name' | 'allowedEmailDomain' | 'allowedEmails' | 'domainGatingEnabled' | 'emailAllowlistEnabled' | 'modelPreferences' | 'enabledLoginProviders' | 'driveLabelsGuardEnabled' | 'driveRequiredLabelIds' | 'driveLabelsFailMode'>>
): Promise<OrgSettings> {
  const setValues: Record<string, unknown> = {};

  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.allowedEmailDomain !== undefined) setValues.allowedEmailDomain = updates.allowedEmailDomain || null;
  if (updates.allowedEmails !== undefined) setValues.allowedEmails = updates.allowedEmails || null;
  if (updates.domainGatingEnabled !== undefined) setValues.domainGatingEnabled = updates.domainGatingEnabled;
  if (updates.emailAllowlistEnabled !== undefined) setValues.emailAllowlistEnabled = updates.emailAllowlistEnabled;
  if (updates.modelPreferences !== undefined) setValues.modelPreferences = updates.modelPreferences && updates.modelPreferences.length > 0 ? updates.modelPreferences : null;
  if (updates.enabledLoginProviders !== undefined) setValues.enabledLoginProviders = updates.enabledLoginProviders && updates.enabledLoginProviders.length > 0 ? updates.enabledLoginProviders : null;
  if (updates.driveLabelsGuardEnabled !== undefined) setValues.driveLabelsGuardEnabled = updates.driveLabelsGuardEnabled ? 1 : 0;
  if (updates.driveRequiredLabelIds !== undefined) setValues.driveRequiredLabelIds = JSON.stringify(updates.driveRequiredLabelIds);
  if (updates.driveLabelsFailMode !== undefined) setValues.driveLabelsFailMode = updates.driveLabelsFailMode;

  if (Object.keys(setValues).length > 0) {
    setValues.updatedAt = sql`datetime('now')`;
    await db
      .update(orgSettings)
      .set(setValues)
      .where(eq(orgSettings.id, 'default'));
  }

  return getOrgSettings(db);
}

// Org API key operations
export async function listOrgApiKeys(db: AppDb): Promise<OrgApiKey[]> {
  const rows = await db
    .select({
      id: orgApiKeys.id,
      provider: orgApiKeys.provider,
      models: orgApiKeys.models,
      showAllModels: orgApiKeys.showAllModels,
      setBy: orgApiKeys.setBy,
      createdAt: orgApiKeys.createdAt,
      updatedAt: orgApiKeys.updatedAt,
    })
    .from(orgApiKeys)
    .orderBy(asc(orgApiKeys.provider));

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    isSet: true,
    models: (row.models as OrgApiKey['models']) || undefined,
    showAllModels: row.showAllModels ?? true,
    setBy: row.setBy,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  }));
}

export async function getOrgApiKey(db: AppDb, provider: string): Promise<{ encryptedKey: string } | null> {
  const row = await db
    .select({ encryptedKey: orgApiKeys.encryptedKey })
    .from(orgApiKeys)
    .where(eq(orgApiKeys.provider, provider))
    .get();
  return row || null;
}

export async function setOrgApiKey(
  db: AppDb,
  params: { id: string; provider: string; encryptedKey: string; setBy: string; models?: string | null; showAllModels?: boolean }
): Promise<void> {
  await db.insert(orgApiKeys).values({
    id: params.id,
    provider: params.provider,
    encryptedKey: params.encryptedKey,
    models: params.models ? sql`${params.models}` : null,
    showAllModels: params.showAllModels ?? true,
    setBy: params.setBy,
  }).onConflictDoUpdate({
    target: orgApiKeys.provider,
    set: {
      encryptedKey: sql`excluded.encrypted_key`,
      models: sql`excluded.models`,
      showAllModels: sql`excluded.show_all_models`,
      setBy: sql`excluded.set_by`,
      updatedAt: sql`datetime('now')`,
    },
  });
}

export async function updateOrgApiKeyModelConfig(
  db: AppDb,
  provider: string,
  params: { models?: string | null; showAllModels?: boolean }
): Promise<void> {
  const setValues: Record<string, unknown> = {};
  if (params.models !== undefined) setValues.models = params.models ? sql`${params.models}` : null;
  if (params.showAllModels !== undefined) setValues.showAllModels = params.showAllModels;
  if (Object.keys(setValues).length === 0) return;
  setValues.updatedAt = sql`datetime('now')`;
  await db.update(orgApiKeys).set(setValues).where(eq(orgApiKeys.provider, provider));
}

export async function deleteOrgApiKey(db: AppDb, provider: string): Promise<void> {
  await db.delete(orgApiKeys).where(eq(orgApiKeys.provider, provider));
}

export async function getBuiltInProviderModelConfigs(db: AppDb): Promise<Array<{ providerId: string; models: Array<{ id: string; name?: string }>; showAllModels: boolean }>> {
  const rows = await db
    .select({
      provider: orgApiKeys.provider,
      models: orgApiKeys.models,
      showAllModels: orgApiKeys.showAllModels,
    })
    .from(orgApiKeys);

  return rows
    .filter((row) => row.models != null || !(row.showAllModels ?? true))
    .map((row) => ({
      providerId: row.provider,
      models: (row.models as Array<{ id: string; name?: string }>) || [],
      showAllModels: row.showAllModels ?? true,
    }));
}

// Custom provider operations
export async function listCustomProviders(db: AppDb): Promise<CustomProvider[]> {
  const rows = await db
    .select()
    .from(customProviders)
    .orderBy(asc(customProviders.displayName));

  return rows.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    hasKey: !!row.encryptedKey,
    models: row.models as CustomProviderModel[],
    showAllModels: !!row.showAllModels,
    setBy: row.setBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getAllCustomProvidersWithKeys(db: AppDb): Promise<Array<{
  providerId: string;
  displayName: string;
  baseUrl: string;
  encryptedKey: string | null;
  models: CustomProviderModel[];
  showAllModels: boolean;
}>> {
  const rows = await db
    .select({
      providerId: customProviders.providerId,
      displayName: customProviders.displayName,
      baseUrl: customProviders.baseUrl,
      encryptedKey: customProviders.encryptedKey,
      models: customProviders.models,
      showAllModels: customProviders.showAllModels,
    })
    .from(customProviders);

  return rows.map((row) => ({
    providerId: row.providerId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    encryptedKey: row.encryptedKey || null,
    models: row.models as CustomProviderModel[],
    showAllModels: !!row.showAllModels,
  }));
}

export async function upsertCustomProvider(
  db: AppDb,
  params: { id: string; providerId: string; displayName: string; baseUrl: string; encryptedKey: string | null; models: string; showAllModels: boolean; setBy: string }
): Promise<void> {
  await db.insert(customProviders).values({
    id: params.id,
    providerId: params.providerId,
    displayName: params.displayName,
    baseUrl: params.baseUrl,
    encryptedKey: params.encryptedKey,
    models: sql`${params.models}`,
    showAllModels: params.showAllModels,
    setBy: params.setBy,
  }).onConflictDoUpdate({
    target: customProviders.providerId,
    set: {
      displayName: sql`excluded.display_name`,
      baseUrl: sql`excluded.base_url`,
      // Preserve existing key when the update doesn't provide a new one
      encryptedKey: sql`CASE WHEN excluded.encrypted_key IS NOT NULL THEN excluded.encrypted_key ELSE ${customProviders.encryptedKey} END`,
      models: sql`excluded.models`,
      showAllModels: sql`excluded.show_all_models`,
      setBy: sql`excluded.set_by`,
      updatedAt: sql`datetime('now')`,
    },
  });
}

export async function deleteCustomProvider(db: AppDb, providerId: string): Promise<void> {
  await db.delete(customProviders).where(eq(customProviders.providerId, providerId));
}

// Invite operations
export async function createInvite(
  db: AppDb,
  params: { id: string; code: string; email?: string; role: UserRole; invitedBy: string; expiresAt: string }
): Promise<Invite> {
  await db.insert(invites).values({
    id: params.id,
    code: params.code,
    email: params.email || null,
    role: params.role,
    invitedBy: params.invitedBy,
    expiresAt: params.expiresAt,
  });

  return {
    id: params.id,
    code: params.code,
    email: params.email,
    role: params.role,
    invitedBy: params.invitedBy,
    expiresAt: new Date(params.expiresAt),
    createdAt: new Date(),
  };
}

export async function getInviteByEmail(db: AppDb, email: string): Promise<Invite | null> {
  const row = await db
    .select()
    .from(invites)
    .where(and(eq(invites.email, email), isNull(invites.acceptedAt), gt(invites.expiresAt, sql`datetime('now')`)))
    .get();
  return row ? rowToInvite(row) : null;
}

export async function getInviteByCode(db: AppDb, code: string): Promise<Invite | null> {
  const row = await db
    .select()
    .from(invites)
    .where(and(eq(invites.code, code), isNull(invites.acceptedAt), gt(invites.expiresAt, sql`datetime('now')`)))
    .get();
  return row ? rowToInvite(row) : null;
}

export async function getInviteByCodeAny(db: AppDb, code: string): Promise<Invite | null> {
  const row = await db
    .select()
    .from(invites)
    .where(eq(invites.code, code))
    .get();
  return row ? rowToInvite(row) : null;
}

export async function listInvites(db: AppDb): Promise<Invite[]> {
  const rows = await db.select().from(invites).orderBy(desc(invites.createdAt));
  return rows.map(rowToInvite);
}

export async function deleteInvite(db: AppDb, id: string): Promise<void> {
  await db.delete(invites).where(eq(invites.id, id));
}

export async function markInviteAccepted(db: AppDb, id: string, acceptedBy?: string): Promise<void> {
  await db
    .update(invites)
    .set({ acceptedAt: sql`datetime('now')`, acceptedBy: acceptedBy || null })
    .where(eq(invites.id, id));
}

// Org Repository Operations
export async function createOrgRepository(
  db: AppDb,
  data: { id: string; fullName: string; description?: string; defaultBranch?: string; language?: string }
): Promise<OrgRepository> {
  const parts = data.fullName.split('/');
  const owner = parts[0];
  const name = parts[1];

  await db.insert(orgRepositories).values({
    id: data.id,
    owner,
    name,
    fullName: data.fullName,
    description: data.description || null,
    defaultBranch: data.defaultBranch || 'main',
    language: data.language || null,
  });

  return rowToOrgRepository({
    id: data.id,
    orgId: 'default',
    provider: 'github',
    owner,
    name,
    fullName: data.fullName,
    description: data.description || null,
    defaultBranch: data.defaultBranch || 'main',
    language: data.language || null,
    topics: null,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export async function listOrgRepositories(db: D1Database, orgId: string = 'default'): Promise<OrgRepository[]> {
  // JOIN with persona defaults — keep as raw SQL for the LEFT JOINs
  const result = await db
    .prepare(
      `SELECT r.*, d.persona_id, ap.name as persona_name
       FROM org_repositories r
       LEFT JOIN org_repo_persona_defaults d ON d.org_repo_id = r.id
       LEFT JOIN agent_personas ap ON ap.id = d.persona_id
       WHERE r.org_id = ? AND r.enabled = 1
       ORDER BY r.full_name ASC`
    )
    .bind(orgId)
    .all();

  return (result.results || []).map((row: any) => rowToOrgRepository({
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    description: row.description,
    defaultBranch: row.default_branch,
    language: row.language,
    topics: row.topics,
    enabled: row.enabled,
    personaId: row.persona_id,
    personaName: row.persona_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getOrgRepository(db: AppDb, id: string): Promise<OrgRepository | null> {
  const row = await db.select().from(orgRepositories).where(eq(orgRepositories.id, id)).get();
  return row ? rowToOrgRepository(row) : null;
}

export async function updateOrgRepository(
  db: AppDb,
  id: string,
  updates: Partial<Pick<OrgRepository, 'description' | 'defaultBranch' | 'language' | 'enabled'>>
): Promise<void> {
  const setValues: Record<string, unknown> = {};

  if (updates.description !== undefined) setValues.description = updates.description || null;
  if (updates.defaultBranch !== undefined) setValues.defaultBranch = updates.defaultBranch;
  if (updates.language !== undefined) setValues.language = updates.language || null;
  if (updates.enabled !== undefined) setValues.enabled = updates.enabled;

  if (Object.keys(setValues).length === 0) return;

  setValues.updatedAt = sql`datetime('now')`;
  await db
    .update(orgRepositories)
    .set(setValues)
    .where(eq(orgRepositories.id, id));
}

export async function deleteOrgRepository(db: AppDb, id: string): Promise<void> {
  await db.delete(orgRepositories).where(eq(orgRepositories.id, id));
}

// Model catalog cache operations
export async function getCatalogCache(db: AppDb, key: string): Promise<{ data: string; cachedAt: number } | null> {
  const row = await db
    .select({ data: modelCatalogCache.data, cachedAt: modelCatalogCache.cachedAt })
    .from(modelCatalogCache)
    .where(eq(modelCatalogCache.cacheKey, key))
    .get();
  return row || null;
}

export async function setCatalogCache(db: AppDb, key: string, data: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.insert(modelCatalogCache).values({
    cacheKey: key,
    data,
    cachedAt: now,
  }).onConflictDoUpdate({
    target: modelCatalogCache.cacheKey,
    set: {
      data: sql`excluded.data`,
      cachedAt: sql`excluded.cached_at`,
    },
  });
}

// Org Directory Helper
export async function getOrgAgents(db: AppDb, orgId: string): Promise<OrchestratorIdentity[]> {
  const rows = await db
    .select()
    .from(orchestratorIdentities)
    .where(eq(orchestratorIdentities.orgId, orgId))
    .orderBy(asc(orchestratorIdentities.name));

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId || undefined,
    orgId: row.orgId,
    type: row.type as OrchestratorIdentity['type'],
    name: row.name,
    handle: row.handle,
    avatar: row.avatar || undefined,
    customInstructions: row.customInstructions || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}
