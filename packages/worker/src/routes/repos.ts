import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { ValidationError } from '@valet/shared';
import type { RepoCredential } from '@valet/sdk/repos';
import type { Env, Variables } from '../env.js';
import { repoProviderRegistry, stripProviderSuffix } from '../repos/registry.js';
import * as credentialDb from '../lib/db/credentials.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { decryptStringPBKDF2 } from '../lib/crypto.js';
import { getGitHubConfig } from '../services/github-config.js';

export const reposRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Resolve a repo credential for a specific provider type.
 * Maps the provider ID to the expected credential type and looks it up directly,
 * rather than using the global priority resolver.
 */
async function resolveRepoCredentialForProvider(
  env: Env,
  userId: string,
  providerId: string,
): Promise<RepoCredential> {
  const appDb = getDb(env.DB);

  // Credentials are stored under a shared provider name (e.g. 'github'),
  // not per-provider IDs like 'github-oauth' / 'github-app'.
  const credentialProvider = stripProviderSuffix(providerId);

  // Determine the credential type from the provider ID suffix
  const isApp = providerId.endsWith('-app');
  const credentialType = isApp ? 'app_install' : 'oauth2';

  // For app providers, use org-level only (single installation model)
  let credRow: credentialDb.CredentialRow | null = null;
  if (isApp) {
    const orgSettings = await db.getOrgSettings(appDb);
    if (orgSettings?.id) {
      credRow = await credentialDb.getCredentialRow(appDb, 'org', orgSettings.id, credentialProvider, credentialType);
    }
  } else {
    credRow = await credentialDb.getCredentialRow(appDb, 'user', userId, credentialProvider, credentialType);
  }

  if (!credRow) {
    throw new ValidationError(`No ${providerId} credentials found. Connect ${providerId} first.`);
  }

  let credData: Record<string, unknown>;
  try {
    const json = await decryptStringPBKDF2(credRow.encryptedData, env.ENCRYPTION_KEY);
    credData = JSON.parse(json);
  } catch {
    throw new ValidationError(`Failed to decrypt ${providerId} credentials`);
  }

  const metadata: Record<string, string> = credRow.metadata ? JSON.parse(credRow.metadata) : {};
  // Merge decrypted credential fields into metadata so providers can access
  // secrets (e.g. app_id, private_key) that are stored encrypted in D1
  for (const [k, v] of Object.entries(credData)) {
    if (typeof v === 'string') metadata[k] = v;
  }

  // For App installations, supplement appId/privateKey from service config
  // (the credential row stores installationId, but App secrets live in org_service_configs)
  if (isApp && !metadata.appId && !metadata.app_id) {
    const ghConfig = await getGitHubConfig(env, appDb);
    if (ghConfig?.appId) metadata.appId = ghConfig.appId;
    if (ghConfig?.appPrivateKey) metadata.privateKey = ghConfig.appPrivateKey;
  }

  return {
    type: credRow.credentialType === 'app_install' ? 'installation' : 'token',
    installationId: metadata.installationId || metadata.installation_id,
    accessToken: (credData.access_token || credData.token) as string | undefined,
    expiresAt: credRow.expiresAt ?? undefined,
    metadata,
  };
}

/**
 * Get a GitHub access token for API operations (PRs, issues, etc.).
 * Uses the same credential priority as repo access: user OAuth first,
 * then org App installation, then user App installation.
 */
async function getGitHubToken(env: Env, userId: string, repoOwner?: string): Promise<string> {
  const appDb = getDb(env.DB);
  const orgSettings = await db.getOrgSettings(appDb);
  const resolved = await credentialDb.resolveRepoCredential(appDb, 'github', repoOwner, orgSettings?.id, userId);
  if (!resolved) {
    throw new ValidationError('GitHub account not connected. Link your GitHub account or ask an org admin to install the GitHub App.');
  }

  // For OAuth tokens, return directly
  if (resolved.credentialType === 'oauth2') {
    let credData: Record<string, unknown>;
    try {
      const json = await decryptStringPBKDF2(resolved.credential.encryptedData, env.ENCRYPTION_KEY);
      credData = JSON.parse(json);
    } catch {
      throw new ValidationError('Failed to decrypt GitHub credentials');
    }
    const token = (credData.access_token || credData.token) as string | undefined;
    if (!token) throw new ValidationError('GitHub OAuth credential has no access token');
    return token;
  }

  // For App installations, mint a fresh token
  const credRow = resolved.credential;
  let credData: Record<string, unknown>;
  try {
    const json = await decryptStringPBKDF2(credRow.encryptedData, env.ENCRYPTION_KEY);
    credData = JSON.parse(json);
  } catch {
    throw new ValidationError('Failed to decrypt GitHub credentials');
  }

  const metadata: Record<string, string> = credRow.metadata ? JSON.parse(credRow.metadata) : {};
  for (const [k, v] of Object.entries(credData)) {
    if (typeof v === 'string') metadata[k] = v;
  }

  // Supplement with App secrets from service config if not already present
  if (!metadata.appId && !metadata.app_id) {
    const ghConfig = await getGitHubConfig(env, appDb);
    if (ghConfig?.appId) metadata.appId = ghConfig.appId;
    if (ghConfig?.appPrivateKey) metadata.privateKey = ghConfig.appPrivateKey;
  }

  const provider = repoProviderRegistry.get('github-app');
  if (!provider) {
    throw new ValidationError('GitHub App provider not registered');
  }

  const repoCredential: RepoCredential = {
    type: 'installation',
    installationId: metadata.installationId || metadata.installation_id,
    accessToken: (credData.access_token || credData.token) as string | undefined,
    metadata,
  };

  const freshToken = await provider.mintToken(repoCredential);
  return freshToken.accessToken;
}

/**
 * GET /api/repos
 * List the authenticated user's repositories via the appropriate repo provider.
 * Queries all registered repo providers and merges results.
 */
reposRouter.get('/', async (c) => {
  const user = c.get('user');
  const page = parseInt(c.req.query('page') || '1');
  const perPage = Math.min(parseInt(c.req.query('per_page') || '30'), 100);
  const search = c.req.query('search') || undefined;
  const providerId = c.req.query('provider');

  const providers = providerId
    ? [repoProviderRegistry.get(providerId)].filter(Boolean)
    : repoProviderRegistry.list();

  if (providers.length === 0) {
    return c.json({ repos: [], page, perPage });
  }

  const allRepos: Array<Record<string, unknown>> = [];
  const seenFullNames = new Set<string>();

  for (const provider of providers) {
    if (!provider) continue;
    try {
      const credential = await resolveRepoCredentialForProvider(c.env, user.id, provider.id);
      const freshToken = await provider.mintToken(credential);
      const freshCredential: RepoCredential = { ...credential, accessToken: freshToken.accessToken };
      const result = await provider.listRepos(freshCredential, { page, search });
      for (const repo of result.repos) {
        // Deduplicate repos by fullName across providers
        if (seenFullNames.has(repo.fullName)) continue;
        seenFullNames.add(repo.fullName);
        allRepos.push({
          id: repo.id ?? 0,
          name: repo.name ?? repo.fullName.split('/').pop() ?? '',
          fullName: repo.fullName,
          private: repo.private,
          description: repo.description ?? null,
          url: repo.url,
          cloneUrl: repo.cloneUrl ?? `${repo.url}.git`,
          defaultBranch: repo.defaultBranch,
          updatedAt: repo.updatedAt ?? new Date().toISOString(),
          language: repo.language ?? null,
          provider: provider.id,
        });
      }
    } catch {
      // Skip providers where the user has no credentials
    }
  }

  return c.json({
    repos: allRepos,
    page,
    perPage,
  });
});

/**
 * GET /api/repos/validate
 * Validate the user has access to a given repo URL
 */
reposRouter.get('/validate', async (c) => {
  const user = c.get('user');
  const url = c.req.query('url');

  if (!url) {
    throw new ValidationError('Missing url parameter');
  }

  // Resolve which repo providers handle this URL
  const providers = repoProviderRegistry.resolveAllByUrl(url);
  if (providers.length === 0) {
    return c.json({ valid: false, error: 'No repo provider found for this URL' });
  }

  // Use credential-driven resolution: find the best credential, then pick the matching provider
  const credentialProvider = stripProviderSuffix(providers[0].id);
  const appDb = getDb(c.env.DB);
  const orgSettings = await db.getOrgSettings(appDb);
  // Extract owner from URL for repo-aware resolution
  const urlMatch = url.match(/github\.com[/:]([^/]+)\//);
  const repoOwner = urlMatch?.[1];
  const resolved = await credentialDb.resolveRepoCredential(appDb, credentialProvider, repoOwner, orgSettings?.id, user.id);
  if (!resolved) {
    return c.json({ valid: false, error: `No ${credentialProvider} credentials found. Connect ${credentialProvider} first.` });
  }
  const providerId = resolved.credentialType === 'oauth2' ? `${credentialProvider}-oauth` : `${credentialProvider}-app`;
  const provider = repoProviderRegistry.get(providerId) || providers[0];

  try {
    const credential = await resolveRepoCredentialForProvider(c.env, user.id, provider.id);
    const freshToken = await provider.mintToken(credential);
    const freshCredential: RepoCredential = { ...credential, accessToken: freshToken.accessToken };
    const validation = await provider.validateRepo(freshCredential, url);

    if (!validation.accessible) {
      return c.json({ valid: false, error: validation.error || 'Repository not accessible' });
    }

    return c.json({
      valid: true,
      repo: {
        fullName: validation.fullName ?? url,
        defaultBranch: validation.defaultBranch ?? 'main',
        private: validation.private ?? false,
        canPush: validation.permissions?.push ?? false,
        cloneUrl: validation.cloneUrl ?? url,
        provider: provider.id,
      },
    });
  } catch (err) {
    return c.json({
      valid: false,
      error: err instanceof ValidationError ? err.message : 'Failed to validate repository',
    });
  }
});

/**
 * GET /api/repos/:owner/:repo/pulls
 * List open pull requests for a repository
 */
reposRouter.get('/:owner/:repo/pulls', async (c) => {
  const user = c.get('user');
  const { owner, repo } = c.req.param();

  const token = await getGitHubToken(c.env, user.id, owner);

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Valet',
      },
    },
  );

  if (!res.ok) {
    const err = await res.text();
    console.error('GitHub pulls fetch failed:', res.status, err);
    return c.json({ error: 'Failed to fetch pull requests' }, 502);
  }

  const pulls = (await res.json()) as Array<{
    number: number;
    title: string;
    state: string;
    draft: boolean;
    body: string | null;
    html_url: string;
    updated_at: string;
    user: { login: string; avatar_url: string };
    head: { ref: string; sha: string; repo: { full_name: string; clone_url: string } };
    base: { ref: string; sha: string };
  }>;

  return c.json({
    pulls: pulls.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      body: pr.body,
      url: pr.html_url,
      updatedAt: pr.updated_at,
      author: { login: pr.user.login, avatarUrl: pr.user.avatar_url },
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      repoFullName: pr.head.repo?.full_name,
      repoCloneUrl: pr.head.repo?.clone_url,
    })),
  });
});

/**
 * GET /api/repos/:owner/:repo/issues
 * List open issues (excluding PRs) for a repository
 */
reposRouter.get('/:owner/:repo/issues', async (c) => {
  const user = c.get('user');
  const { owner, repo } = c.req.param();

  const token = await getGitHubToken(c.env, user.id, owner);

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=open&sort=updated&direction=desc&per_page=30`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Valet',
      },
    },
  );

  if (!res.ok) {
    const err = await res.text();
    console.error('GitHub issues fetch failed:', res.status, err);
    return c.json({ error: 'Failed to fetch issues' }, 502);
  }

  const allItems = (await res.json()) as Array<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    updated_at: string;
    pull_request?: unknown;
    labels: Array<{ name: string; color: string }>;
    assignees: Array<{ login: string; avatar_url: string }>;
    user: { login: string; avatar_url: string };
  }>;

  // GitHub returns PRs in the issues endpoint — filter them out
  const issues = allItems.filter((item) => !item.pull_request);

  return c.json({
    issues: issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.html_url,
      updatedAt: issue.updated_at,
      author: { login: issue.user.login, avatarUrl: issue.user.avatar_url },
      labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
      assignees: issue.assignees.map((a) => ({ login: a.login, avatarUrl: a.avatar_url })),
    })),
  });
});

const createPRSchema = z.object({
  branch: z.string().min(1),
  title: z.string().min(1).max(256),
  body: z.string().optional(),
  base: z.string().optional(),
});

/**
 * POST /api/repos/pull-request
 * Create a pull request on GitHub for a given repo.
 * The session's repo URL is used to determine owner/repo.
 */
reposRouter.post('/pull-request', zValidator('json', createPRSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const repoUrl = c.req.query('repo');
  if (!repoUrl) {
    throw new ValidationError('Missing repo query parameter');
  }

  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) {
    throw new ValidationError('Invalid GitHub repository URL');
  }

  const [, owner, repo] = match;
  const token = await getGitHubToken(c.env, user.id, owner);

  // Determine base branch if not provided
  let baseBranch = body.base;
  if (!baseBranch) {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Valet',
      },
    });
    if (repoRes.ok) {
      const repoData = (await repoRes.json()) as { default_branch: string };
      baseBranch = repoData.default_branch;
    } else {
      baseBranch = 'main';
    }
  }

  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Valet',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: body.title,
      body: body.body || '',
      head: body.branch,
      base: baseBranch,
    }),
  });

  if (!prRes.ok) {
    const err = await prRes.text();
    console.error('GitHub PR creation failed:', prRes.status, err);
    return c.json({ error: 'Failed to create pull request', details: err }, 502);
  }

  const pr = (await prRes.json()) as {
    number: number;
    html_url: string;
    title: string;
    state: string;
  };

  return c.json({
    pr: {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      state: pr.state,
    },
  });
});
