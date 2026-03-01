import type { SyncResult, SyncError } from '@agent-ops/shared';
import type { GitHub } from '@agent-ops/shared';
import type { SyncSource, IntegrationCredentials, SyncOptions } from '@agent-ops/sdk';
import { githubFetch } from './api.js';

interface GitHubApiRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  default_branch: string;
}

interface GitHubApiIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

interface GitHubApiPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged_at: string | null;
  created_at: string;
  updated_at: string;
}

function getToken(credentials: IntegrationCredentials): string {
  return credentials.access_token || credentials.token || '';
}

function syncError(entity: string, message: string, code: string): SyncError {
  return { entity, message, code };
}

async function syncRepositories(token: string): Promise<SyncResult> {
  const repos: GitHub.Repository[] = [];
  let page = 1;
  const perPage = 100;

  try {
    while (true) {
      const res = await githubFetch(`/user/repos?per_page=${perPage}&page=${page}&sort=updated`, token);
      if (!res.ok) {
        return {
          success: false, recordsSynced: 0,
          errors: [syncError('repositories', `Failed to fetch repos: ${res.status}`, 'FETCH_FAILED')],
          completedAt: new Date(),
        };
      }

      const data = (await res.json()) as GitHubApiRepo[];
      if (data.length === 0) break;

      for (const repo of data) {
        repos.push({
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          description: repo.description,
          url: repo.html_url,
          defaultBranch: repo.default_branch,
        });
      }

      if (data.length < perPage) break;
      page++;
    }
    return { success: true, recordsSynced: repos.length, errors: [], completedAt: new Date() };
  } catch (error) {
    return {
      success: false, recordsSynced: 0,
      errors: [syncError('repositories', String(error), 'SYNC_ERROR')],
      completedAt: new Date(),
    };
  }
}

async function syncIssues(token: string): Promise<SyncResult> {
  const issues: GitHub.Issue[] = [];

  try {
    const reposRes = await githubFetch('/user/repos?per_page=100&sort=updated', token);
    if (!reposRes.ok) {
      return {
        success: false, recordsSynced: 0,
        errors: [syncError('issues', 'Failed to fetch repos', 'FETCH_FAILED')],
        completedAt: new Date(),
      };
    }

    const repos = (await reposRes.json()) as GitHubApiRepo[];

    for (const repo of repos.slice(0, 10)) {
      const issuesRes = await githubFetch(
        `/repos/${repo.full_name}/issues?state=all&per_page=50&sort=updated`,
        token,
      );

      if (issuesRes.ok) {
        const repoIssues = (await issuesRes.json()) as GitHubApiIssue[];
        for (const issue of repoIssues) {
          if (issue.pull_request) continue;
          issues.push({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: issue.labels.map((l) => l.name),
            assignees: issue.assignees.map((a) => a.login),
            createdAt: new Date(issue.created_at),
            updatedAt: new Date(issue.updated_at),
          });
        }
      }
    }
    return { success: true, recordsSynced: issues.length, errors: [], completedAt: new Date() };
  } catch (error) {
    return {
      success: false, recordsSynced: 0,
      errors: [syncError('issues', String(error), 'SYNC_ERROR')],
      completedAt: new Date(),
    };
  }
}

async function syncPullRequests(token: string): Promise<SyncResult> {
  const pullRequests: GitHub.PullRequest[] = [];

  try {
    const reposRes = await githubFetch('/user/repos?per_page=100&sort=updated', token);
    if (!reposRes.ok) {
      return {
        success: false, recordsSynced: 0,
        errors: [syncError('pull_requests', 'Failed to fetch repos', 'FETCH_FAILED')],
        completedAt: new Date(),
      };
    }

    const repos = (await reposRes.json()) as GitHubApiRepo[];

    for (const repo of repos.slice(0, 10)) {
      const prsRes = await githubFetch(
        `/repos/${repo.full_name}/pulls?state=all&per_page=50&sort=updated`,
        token,
      );

      if (prsRes.ok) {
        const repoPRs = (await prsRes.json()) as GitHubApiPullRequest[];
        for (const pr of repoPRs) {
          pullRequests.push({
            id: pr.id,
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.merged_at ? 'merged' : pr.state,
            head: pr.head,
            base: pr.base,
            createdAt: new Date(pr.created_at),
            updatedAt: new Date(pr.updated_at),
            mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
          });
        }
      }
    }
    return { success: true, recordsSynced: pullRequests.length, errors: [], completedAt: new Date() };
  } catch (error) {
    return {
      success: false, recordsSynced: 0,
      errors: [syncError('pull_requests', String(error), 'SYNC_ERROR')],
      completedAt: new Date(),
    };
  }
}

export const githubSync: SyncSource = {
  async sync(credentials: IntegrationCredentials, options: SyncOptions): Promise<SyncResult> {
    const token = getToken(credentials);
    if (!token) {
      return {
        success: false, recordsSynced: 0,
        errors: [syncError('auth', 'Invalid credentials', 'INVALID_CREDENTIALS')],
        completedAt: new Date(),
      };
    }

    const entities = options.entities || ['repositories', 'issues', 'pull_requests'];
    let totalSynced = 0;
    const errors: SyncError[] = [];

    if (entities.includes('repositories')) {
      const result = await syncRepositories(token);
      totalSynced += result.recordsSynced;
      errors.push(...result.errors);
    }

    if (entities.includes('issues')) {
      const result = await syncIssues(token);
      totalSynced += result.recordsSynced;
      errors.push(...result.errors);
    }

    if (entities.includes('pull_requests')) {
      const result = await syncPullRequests(token);
      totalSynced += result.recordsSynced;
      errors.push(...result.errors);
    }

    return {
      success: errors.length === 0,
      recordsSynced: totalSynced,
      errors,
      completedAt: new Date(),
    };
  },
};
