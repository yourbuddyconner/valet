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

const allActions: ActionDefinition[] = [
  getRepository,
  listRepos,
  getIssue,
  createIssue,
  getPullRequest,
  createComment,
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
