import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { githubFetch } from './api.js';

// ─── Action Definitions ──────────────────────────────────────────────────────

const getRepository: ActionDefinition = {
  id: 'github.get_repository',
  name: 'Get Repository',
  description: 'Get details of a GitHub repository by owner/name',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
  }),
};

const listRepos: ActionDefinition = {
  id: 'github.list_repos',
  name: 'List Repositories',
  description: 'List repositories for the authenticated user',
  riskLevel: 'low',
  params: z.object({
    sort: z.enum(['created', 'updated', 'pushed', 'full_name']).optional().describe('Sort field'),
    perPage: z.number().int().min(1).max(100).optional().describe('Results per page'),
    page: z.number().int().min(1).optional().describe('Page number'),
  }),
};

const getIssue: ActionDefinition = {
  id: 'github.get_issue',
  name: 'Get Issue',
  description: 'Get a specific issue by number',
  riskLevel: 'low',
  params: z.object({
    owner: z.string(),
    repo: z.string(),
    issueNumber: z.number().int(),
  }),
};

const createIssue: ActionDefinition = {
  id: 'github.create_issue',
  name: 'Create Issue',
  description: 'Create a new issue in a repository',
  riskLevel: 'medium',
  params: z.object({
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional(),
  }),
};

const getPullRequest: ActionDefinition = {
  id: 'github.get_pull_request',
  name: 'Get Pull Request',
  description: 'Get a specific pull request by number',
  riskLevel: 'low',
  params: z.object({
    owner: z.string(),
    repo: z.string(),
    pullNumber: z.number().int(),
  }),
};

const createComment: ActionDefinition = {
  id: 'github.create_comment',
  name: 'Create Comment',
  description: 'Create a comment on an issue or pull request',
  riskLevel: 'medium',
  params: z.object({
    owner: z.string(),
    repo: z.string(),
    issueNumber: z.number().int(),
    body: z.string(),
  }),
};

const listPullRequests: ActionDefinition = {
  id: 'github.list_pull_requests',
  name: 'List Pull Requests',
  description: 'List pull requests for a repository with optional state filter',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter (default: open)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 30, max 100)'),
  }),
};

const inspectPullRequest: ActionDefinition = {
  id: 'github.inspect_pull_request',
  name: 'Inspect Pull Request',
  description: 'Get detailed PR info including files changed, review comments, and check status',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    pullNumber: z.number().int().describe('Pull request number'),
    filesLimit: z.number().int().min(1).max(300).optional().describe('Max files to return (default: 100)'),
    commentsLimit: z.number().int().min(1).max(300).optional().describe('Max review comments (default: 100)'),
  }),
};

const updatePullRequest: ActionDefinition = {
  id: 'github.update_pull_request',
  name: 'Update Pull Request',
  description: 'Update a pull request title, body, state, or labels',
  riskLevel: 'medium',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    pullNumber: z.number().int().describe('Pull request number'),
    title: z.string().optional().describe('New title'),
    body: z.string().optional().describe('New body (markdown)'),
    state: z.enum(['open', 'closed']).optional().describe('Set PR state'),
    labels: z.array(z.string()).optional().describe('Labels to set (replaces existing)'),
  }),
};

const readRepoFile: ActionDefinition = {
  id: 'github.read_repo_file',
  name: 'Read Repository File',
  description: 'Read a file from a GitHub repository without cloning it',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    path: z.string().describe('File path in the repository'),
    ref: z.string().optional().describe('Git ref (branch, tag, or commit SHA)'),
  }),
};

const allActions: ActionDefinition[] = [
  getRepository,
  listRepos,
  getIssue,
  createIssue,
  getPullRequest,
  createComment,
  listPullRequests,
  inspectPullRequest,
  updatePullRequest,
  readRepoFile,
];

// ─── Action Execution ────────────────────────────────────────────────────────

function getToken(ctx: ActionContext): string {
  return ctx.credentials.access_token || ctx.credentials.token || '';
}

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = getToken(ctx);
  if (!token) {
    return { success: false, error: 'Missing access token' };
  }

  try {
    switch (actionId) {
      case 'github.get_repository': {
        const { owner, repo } = getRepository.params.parse(params);
        const res = await githubFetch(`/repos/${owner}/${repo}`, token);
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        return { success: true, data: await res.json() };
      }

      case 'github.list_repos': {
        const p = listRepos.params.parse(params);
        const qs = new URLSearchParams();
        if (p.sort) qs.set('sort', p.sort);
        if (p.perPage) qs.set('per_page', String(p.perPage));
        if (p.page) qs.set('page', String(p.page));
        const res = await githubFetch(`/user/repos?${qs}`, token);
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        return { success: true, data: await res.json() };
      }

      case 'github.get_issue': {
        const { owner, repo, issueNumber } = getIssue.params.parse(params);
        const res = await githubFetch(`/repos/${owner}/${repo}/issues/${issueNumber}`, token);
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        return { success: true, data: await res.json() };
      }

      case 'github.create_issue': {
        const { owner, repo, title, body } = createIssue.params.parse(params);
        const res = await githubFetch(`/repos/${owner}/${repo}/issues`, token, {
          method: 'POST',
          body: JSON.stringify({ title, body }),
        });
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        return { success: true, data: await res.json() };
      }

      case 'github.get_pull_request': {
        const { owner, repo, pullNumber } = getPullRequest.params.parse(params);
        const res = await githubFetch(`/repos/${owner}/${repo}/pulls/${pullNumber}`, token);
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        return { success: true, data: await res.json() };
      }

      case 'github.create_comment': {
        const { owner, repo, issueNumber, body } = createComment.params.parse(params);
        const res = await githubFetch(
          `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
          token,
          { method: 'POST', body: JSON.stringify({ body }) },
        );
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        return { success: true, data: await res.json() };
      }

      case 'github.list_pull_requests': {
        const p = listPullRequests.params.parse(params);
        const state = p.state || 'open';
        const limit = Math.min(Math.max(p.limit ?? 30, 1), 100);
        const res = await githubFetch(
          `/repos/${p.owner}/${p.repo}/pulls?state=${encodeURIComponent(state)}&sort=updated&direction=desc&per_page=${limit}`,
          token,
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const pulls = (await res.json()) as Array<Record<string, unknown>>;
        return {
          success: true,
          data: pulls.map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            user: (pr.user as Record<string, unknown>)?.login,
            url: pr.html_url,
            draft: pr.draft,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            head: (pr.head as Record<string, unknown>)?.ref,
            base: (pr.base as Record<string, unknown>)?.ref,
          })),
        };
      }

      case 'github.inspect_pull_request': {
        const p = inspectPullRequest.params.parse(params);
        const filesLimit = Math.min(Math.max(p.filesLimit ?? 100, 1), 300);
        const commentsLimit = Math.min(Math.max(p.commentsLimit ?? 100, 1), 300);

        // Fetch PR, files, reviews, comments, and checks in parallel
        const [prRes, filesRes, reviewsRes, commentsRes] = await Promise.all([
          githubFetch(`/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}`, token),
          githubFetch(`/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}/files?per_page=${filesLimit}`, token),
          githubFetch(`/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}/reviews`, token),
          githubFetch(`/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}/comments?per_page=${commentsLimit}`, token),
        ]);

        if (!prRes.ok) return { success: false, error: `GitHub API error (${prRes.status}): ${await prRes.text()}` };

        const pr = await prRes.json() as Record<string, unknown>;
        const files = filesRes.ok ? (await filesRes.json() as Array<Record<string, unknown>>) : [];
        const reviews = reviewsRes.ok ? (await reviewsRes.json() as Array<Record<string, unknown>>) : [];
        const comments = commentsRes.ok ? (await commentsRes.json() as Array<Record<string, unknown>>) : [];

        // Get check runs for the head SHA
        const headSha = ((pr.head as Record<string, unknown>)?.sha as string) || '';
        let checks: Array<Record<string, unknown>> = [];
        if (headSha) {
          const checksRes = await githubFetch(`/repos/${p.owner}/${p.repo}/commits/${headSha}/check-runs`, token);
          if (checksRes.ok) {
            const checksData = await checksRes.json() as { check_runs?: Array<Record<string, unknown>> };
            checks = checksData.check_runs ?? [];
          }
        }

        return {
          success: true,
          data: {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            merged: pr.merged,
            draft: pr.draft,
            user: (pr.user as Record<string, unknown>)?.login,
            url: pr.html_url,
            head: { ref: (pr.head as Record<string, unknown>)?.ref, sha: headSha },
            base: { ref: (pr.base as Record<string, unknown>)?.ref },
            body: pr.body,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
            files: files.map((f) => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            })),
            reviews: reviews.filter((r) => r.state !== 'DISMISSED').map((r) => ({
              user: (r.user as Record<string, unknown>)?.login,
              state: r.state,
              body: r.body,
            })),
            comments: comments.map((c) => ({
              user: (c.user as Record<string, unknown>)?.login,
              path: c.path,
              line: c.line ?? c.original_line,
              body: c.body,
            })),
            checks: checks.map((c) => ({
              name: c.name,
              status: c.status,
              conclusion: c.conclusion,
            })),
          },
        };
      }

      case 'github.update_pull_request': {
        const p = updatePullRequest.params.parse(params);
        const body: Record<string, unknown> = {};
        if (p.title !== undefined) body.title = p.title;
        if (p.body !== undefined) body.body = p.body;
        if (p.state !== undefined) body.state = p.state;
        const res = await githubFetch(
          `/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}`,
          token,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const prData = await res.json() as Record<string, unknown>;

        // Set labels separately if provided
        if (p.labels) {
          await githubFetch(
            `/repos/${p.owner}/${p.repo}/issues/${p.pullNumber}/labels`,
            token,
            { method: 'PUT', body: JSON.stringify({ labels: p.labels }) },
          );
        }

        return { success: true, data: { number: prData.number, url: prData.html_url, title: prData.title, state: prData.state } };
      }

      case 'github.read_repo_file': {
        const p = readRepoFile.params.parse(params);
        const qs = p.ref ? `?ref=${encodeURIComponent(p.ref)}` : '';
        const res = await githubFetch(`/repos/${p.owner}/${p.repo}/contents/${p.path}${qs}`, token);
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const data = await res.json() as Record<string, unknown>;

        if (data.type !== 'file') {
          return { success: false, error: `Path is a ${data.type}, not a file` };
        }

        const content = data.encoding === 'base64'
          ? atob(data.content as string)
          : (data.content as string);

        return {
          success: true,
          data: {
            path: data.path,
            repo: `${p.owner}/${p.repo}`,
            ref: p.ref,
            size: data.size,
            content,
          },
        };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const githubActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
