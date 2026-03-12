import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { ValidationError } from '@valet/shared';
import type { RepoCredential } from '@valet/sdk/repos';
import type { Env, Variables } from '../env.js';
import { getCredential } from '../services/credentials.js';
import { repoProviderRegistry } from '../repos/registry.js';
import * as credentialDb from '../lib/db/credentials.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { decryptStringPBKDF2 } from '../lib/crypto.js';

export const reposRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Resolve a repo credential for the given provider, preferring org app_install.
 */
async function resolveRepoCredentialForProvider(
  env: Env,
  userId: string,
  providerId: string,
): Promise<RepoCredential> {
  const appDb = getDb(env.DB);

  // Try org-level first, then user-level
  const orgSettings = await db.getOrgSettings(appDb);
  const credRow = await credentialDb.resolveRepoCredential(appDb, providerId, orgSettings?.id, userId);
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

  return {
    type: credRow.credentialType === 'app_install' ? 'installation' : 'token',
    installationId: metadata.installationId,
    accessToken: (credData.access_token || credData.token) as string | undefined,
    expiresAt: credRow.expiresAt ?? undefined,
    metadata,
  };
}

/**
 * Get the user's decrypted GitHub access token. Throws if not connected.
 * Used by GitHub-specific routes (pulls, issues, PR creation).
 */
async function getGitHubToken(env: Env, userId: string): Promise<string> {
  const result = await getCredential(env, 'user', userId, 'github');
  if (!result.ok) {
    throw new ValidationError('GitHub account not connected');
  }
  return result.credential.accessToken;
}

/**
 * GET /api/repos
 * List the authenticated user's repositories via the appropriate repo provider.
 * Queries all registered repo providers and merges results.
 */
reposRouter.get('/', async (c) => {
  const user = c.get('user');
  const page = parseInt(c.req.query('page') || '1');
  const search = c.req.query('search') || undefined;
  const providerId = c.req.query('provider');

  const providers = providerId
    ? [repoProviderRegistry.get(providerId)].filter(Boolean)
    : repoProviderRegistry.list();

  if (providers.length === 0) {
    return c.json({ repos: [], page, perPage: 30 });
  }

  const allRepos: Array<{
    fullName: string;
    url: string;
    defaultBranch: string;
    private: boolean;
    provider: string;
  }> = [];

  for (const provider of providers) {
    if (!provider) continue;
    try {
      const credential = await resolveRepoCredentialForProvider(c.env, user.id, provider.id);
      const freshToken = await provider.mintToken(credential);
      const freshCredential: RepoCredential = { ...credential, accessToken: freshToken.accessToken };
      const result = await provider.listRepos(freshCredential, { page, search });
      for (const repo of result.repos) {
        allRepos.push({ ...repo, provider: provider.id });
      }
    } catch {
      // Skip providers where the user has no credentials
    }
  }

  return c.json({
    repos: allRepos,
    page,
    perPage: 30,
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

  // Resolve which repo provider handles this URL
  const provider = repoProviderRegistry.resolveByUrl(url);
  if (!provider) {
    return c.json({ valid: false, error: 'No repo provider found for this URL' });
  }

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
        fullName: url,
        canPush: validation.permissions?.push ?? false,
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

  const token = await getGitHubToken(c.env, user.id);

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

  const token = await getGitHubToken(c.env, user.id);

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
  const token = await getGitHubToken(c.env, user.id);

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
