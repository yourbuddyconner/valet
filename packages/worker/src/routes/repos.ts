import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { ValidationError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import { getCredential } from '../services/credentials.js';

export const reposRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Get the user's decrypted GitHub access token. Throws if not connected.
 */
async function getGitHubToken(env: Env, userId: string): Promise<string> {
  const result = await getCredential(env, userId, 'github');
  if (!result.ok) {
    throw new ValidationError('GitHub account not connected');
  }
  return result.credential.accessToken;
}

/**
 * GET /api/repos
 * List the authenticated user's GitHub repositories
 */
reposRouter.get('/', async (c) => {
  const user = c.get('user');
  const page = parseInt(c.req.query('page') || '1');
  const perPage = parseInt(c.req.query('per_page') || '30');
  const sort = c.req.query('sort') || 'updated';

  const token = await getGitHubToken(c.env, user.id);

  const res = await fetch(
    `https://api.github.com/user/repos?sort=${sort}&per_page=${perPage}&page=${page}&type=all`,
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
    console.error('GitHub repos fetch failed:', res.status, err);
    return c.json({ error: 'Failed to fetch repositories' }, 502);
  }

  const repos = (await res.json()) as Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    description: string | null;
    html_url: string;
    clone_url: string;
    default_branch: string;
    updated_at: string;
    language: string | null;
  }>;

  return c.json({
    repos: repos.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      description: r.description,
      url: r.html_url,
      cloneUrl: r.clone_url,
      defaultBranch: r.default_branch,
      updatedAt: r.updated_at,
      language: r.language,
    })),
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

  // Extract owner/repo from GitHub URL
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) {
    return c.json({ valid: false, error: 'Not a valid GitHub repository URL' });
  }

  const [, owner, repo] = match;
  const token = await getGitHubToken(c.env, user.id);

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Valet',
    },
  });

  if (res.status === 404) {
    return c.json({ valid: false, error: 'Repository not found or not accessible' });
  }

  if (!res.ok) {
    return c.json({ valid: false, error: 'Failed to validate repository' });
  }

  const repoData = (await res.json()) as {
    full_name: string;
    default_branch: string;
    private: boolean;
    permissions: { push: boolean };
    clone_url: string;
  };

  return c.json({
    valid: true,
    repo: {
      fullName: repoData.full_name,
      defaultBranch: repoData.default_branch,
      private: repoData.private,
      canPush: repoData.permissions?.push ?? false,
      cloneUrl: repoData.clone_url,
    },
  });
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
