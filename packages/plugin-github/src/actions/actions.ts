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

const createRepository: ActionDefinition = {
  id: 'github.create_repository',
  name: 'Create Repository',
  description: 'Create a new GitHub repository for the authenticated user',
  riskLevel: 'high',
  params: z.object({
    name: z.string().describe('Repository name'),
    description: z.string().optional().describe('Repository description'),
    private: z.boolean().optional().describe('Whether the repository is private (default: false)'),
    autoInit: z.boolean().optional().describe('Initialize with a README (default: false)'),
    gitignoreTemplate: z.string().optional().describe('Gitignore template (e.g. "Node", "Python")'),
    licenseTemplate: z.string().optional().describe('License keyword (e.g. "mit", "apache-2.0")'),
  }),
};

const listIssues: ActionDefinition = {
  id: 'github.list_issues',
  name: 'List Issues',
  description: 'List issues for a repository with optional filters',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter (default: open)'),
    labels: z.string().optional().describe('Comma-separated label names'),
    assignee: z.string().optional().describe('Filter by assignee username, or "none"/"*"'),
    sort: z.enum(['created', 'updated', 'comments']).optional().describe('Sort field'),
    direction: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 30)'),
  }),
};

const updateIssue: ActionDefinition = {
  id: 'github.update_issue',
  name: 'Update Issue',
  description: 'Update an issue title, body, state, labels, or assignees',
  riskLevel: 'medium',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    issueNumber: z.number().int().describe('Issue number'),
    title: z.string().optional().describe('New title'),
    body: z.string().optional().describe('New body (markdown)'),
    state: z.enum(['open', 'closed']).optional().describe('Set issue state'),
    labels: z.array(z.string()).optional().describe('Labels to set (replaces existing)'),
    assignees: z.array(z.string()).optional().describe('Assignee usernames (replaces existing)'),
  }),
};

const createPullRequest: ActionDefinition = {
  id: 'github.create_pull_request',
  name: 'Create Pull Request',
  description: 'Create a new pull request',
  riskLevel: 'medium',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    title: z.string().describe('PR title'),
    head: z.string().describe('Branch containing changes (or "user:branch" for cross-repo)'),
    base: z.string().describe('Branch to merge into'),
    body: z.string().optional().describe('PR description (markdown)'),
    draft: z.boolean().optional().describe('Create as draft PR'),
  }),
};

const mergePullRequest: ActionDefinition = {
  id: 'github.merge_pull_request',
  name: 'Merge Pull Request',
  description: 'Merge a pull request',
  riskLevel: 'high',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    pullNumber: z.number().int().describe('Pull request number'),
    mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (default: merge)'),
    commitTitle: z.string().optional().describe('Custom merge commit title'),
    commitMessage: z.string().optional().describe('Custom merge commit message'),
  }),
};

const createBranch: ActionDefinition = {
  id: 'github.create_branch',
  name: 'Create Branch',
  description: 'Create a new branch from a ref',
  riskLevel: 'medium',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    branch: z.string().describe('New branch name'),
    fromRef: z.string().optional().describe('Source ref — branch, tag, or SHA (default: repo default branch)'),
  }),
};

const deleteBranch: ActionDefinition = {
  id: 'github.delete_branch',
  name: 'Delete Branch',
  description: 'Delete a branch from a repository',
  riskLevel: 'high',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    branch: z.string().describe('Branch name to delete'),
  }),
};

const listCommits: ActionDefinition = {
  id: 'github.list_commits',
  name: 'List Commits',
  description: 'List commits on a branch or path',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    sha: z.string().optional().describe('Branch name or commit SHA to list from'),
    path: z.string().optional().describe('Only commits containing this file path'),
    author: z.string().optional().describe('GitHub username or email to filter by'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 30)'),
  }),
};

const searchCode: ActionDefinition = {
  id: 'github.search_code',
  name: 'Search Code',
  description: 'Search for code across GitHub repositories',
  riskLevel: 'low',
  params: z.object({
    q: z.string().describe('Search query (supports GitHub code search qualifiers like "repo:", "language:", "path:")'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 30)'),
  }),
};

const searchIssues: ActionDefinition = {
  id: 'github.search_issues',
  name: 'Search Issues',
  description: 'Search issues and pull requests across GitHub',
  riskLevel: 'low',
  params: z.object({
    q: z.string().describe('Search query (supports qualifiers like "repo:", "is:issue", "is:pr", "label:", "state:")'),
    sort: z.enum(['created', 'updated', 'comments']).optional().describe('Sort field'),
    order: z.enum(['asc', 'desc']).optional().describe('Sort order'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 30)'),
  }),
};

const createRelease: ActionDefinition = {
  id: 'github.create_release',
  name: 'Create Release',
  description: 'Create a new release (and optionally a tag)',
  riskLevel: 'high',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    tagName: z.string().describe('Tag name for the release'),
    name: z.string().optional().describe('Release title'),
    body: z.string().optional().describe('Release notes (markdown)'),
    targetCommitish: z.string().optional().describe('Branch or commit SHA to tag (default: default branch)'),
    draft: z.boolean().optional().describe('Create as draft release'),
    prerelease: z.boolean().optional().describe('Mark as pre-release'),
    generateReleaseNotes: z.boolean().optional().describe('Auto-generate release notes'),
  }),
};

const forkRepository: ActionDefinition = {
  id: 'github.fork_repository',
  name: 'Fork Repository',
  description: 'Fork a repository to the authenticated user or an organization',
  riskLevel: 'high',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    organization: z.string().optional().describe('Organization to fork to (default: authenticated user)'),
    name: z.string().optional().describe('Custom name for the fork'),
  }),
};

const listWorkflowRuns: ActionDefinition = {
  id: 'github.list_workflow_runs',
  name: 'List Workflow Runs',
  description: 'List GitHub Actions workflow runs for a repository',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    branch: z.string().optional().describe('Filter by branch'),
    status: z.enum(['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending']).optional().describe('Filter by status'),
    event: z.string().optional().describe('Filter by event type (e.g. "push", "pull_request")'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 30)'),
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
  listIssues,
  updateIssue,
  getPullRequest,
  createComment,
  listPullRequests,
  inspectPullRequest,
  updatePullRequest,
  createPullRequest,
  mergePullRequest,
  createRepository,
  forkRepository,
  createBranch,
  deleteBranch,
  listCommits,
  searchCode,
  searchIssues,
  createRelease,
  listWorkflowRuns,
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

      case 'github.list_issues': {
        const p = listIssues.params.parse(params);
        const limit = Math.min(Math.max(p.limit ?? 30, 1), 100);
        const qs = new URLSearchParams();
        if (p.state) qs.set('state', p.state);
        if (p.labels) qs.set('labels', p.labels);
        if (p.assignee) qs.set('assignee', p.assignee);
        if (p.sort) qs.set('sort', p.sort);
        if (p.direction) qs.set('direction', p.direction);
        // Fetch max page size since GitHub's issues endpoint includes PRs which we filter out
        qs.set('per_page', '100');
        const res = await githubFetch(`/repos/${p.owner}/${p.repo}/issues?${qs}`, token);
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const issues = (await res.json()) as Array<Record<string, unknown>>;
        return {
          success: true,
          data: issues
            .filter((i) => !i.pull_request) // exclude PRs from issue list
            .slice(0, limit)
            .map((i) => ({
              number: i.number,
              title: i.title,
              state: i.state,
              user: (i.user as Record<string, unknown>)?.login,
              url: i.html_url,
              labels: (i.labels as Array<Record<string, unknown>>)?.map((l) => l.name),
              assignees: (i.assignees as Array<Record<string, unknown>>)?.map((a) => a.login),
              created_at: i.created_at,
              updated_at: i.updated_at,
            })),
        };
      }

      case 'github.update_issue': {
        const p = updateIssue.params.parse(params);
        const body: Record<string, unknown> = {};
        if (p.title !== undefined) body.title = p.title;
        if (p.body !== undefined) body.body = p.body;
        if (p.state !== undefined) body.state = p.state;
        if (p.labels !== undefined) body.labels = p.labels;
        if (p.assignees !== undefined) body.assignees = p.assignees;
        const res = await githubFetch(
          `/repos/${p.owner}/${p.repo}/issues/${p.issueNumber}`,
          token,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const issue = await res.json() as Record<string, unknown>;
        return { success: true, data: { number: issue.number, url: issue.html_url, title: issue.title, state: issue.state } };
      }

      case 'github.create_pull_request': {
        const p = createPullRequest.params.parse(params);
        const body: Record<string, unknown> = { title: p.title, head: p.head, base: p.base };
        if (p.body !== undefined) body.body = p.body;
        if (p.draft !== undefined) body.draft = p.draft;
        const res = await githubFetch(
          `/repos/${p.owner}/${p.repo}/pulls`,
          token,
          { method: 'POST', body: JSON.stringify(body) },
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const pr = await res.json() as Record<string, unknown>;
        return { success: true, data: { number: pr.number, url: pr.html_url, title: pr.title, state: pr.state, draft: pr.draft } };
      }

      case 'github.merge_pull_request': {
        const p = mergePullRequest.params.parse(params);
        const body: Record<string, unknown> = {};
        if (p.mergeMethod) body.merge_method = p.mergeMethod;
        if (p.commitTitle) body.commit_title = p.commitTitle;
        if (p.commitMessage) body.commit_message = p.commitMessage;
        const res = await githubFetch(
          `/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}/merge`,
          token,
          { method: 'PUT', body: JSON.stringify(body) },
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const data = await res.json() as Record<string, unknown>;
        return { success: true, data: { merged: data.merged, message: data.message, sha: data.sha } };
      }

      case 'github.create_branch': {
        const p = createBranch.params.parse(params);
        let sha: string | undefined;

        if (p.fromRef) {
          // Try as branch name
          const branchRes = await githubFetch(`/repos/${p.owner}/${p.repo}/git/ref/heads/${p.fromRef}`, token);
          if (branchRes.ok) {
            sha = ((await branchRes.json()) as { object?: { sha?: string } }).object?.sha;
          } else {
            // Try as tag
            const tagRes = await githubFetch(`/repos/${p.owner}/${p.repo}/git/ref/tags/${p.fromRef}`, token);
            if (tagRes.ok) {
              sha = ((await tagRes.json()) as { object?: { sha?: string } }).object?.sha;
            } else {
              // Try as raw commit SHA
              const commitRes = await githubFetch(`/repos/${p.owner}/${p.repo}/git/commits/${p.fromRef}`, token);
              if (commitRes.ok) {
                sha = p.fromRef;
              }
            }
          }
          if (!sha) return { success: false, error: `Could not resolve ref "${p.fromRef}"` };
        } else {
          // Discover repo default branch
          const repoRes = await githubFetch(`/repos/${p.owner}/${p.repo}`, token);
          if (!repoRes.ok) return { success: false, error: `Could not fetch repository: ${repoRes.status}` };
          const repoData = await repoRes.json() as { default_branch?: string };
          const defaultBranch = repoData.default_branch || 'main';
          const refRes = await githubFetch(`/repos/${p.owner}/${p.repo}/git/ref/heads/${defaultBranch}`, token);
          if (!refRes.ok) return { success: false, error: `Could not resolve default branch "${defaultBranch}"` };
          sha = ((await refRes.json()) as { object?: { sha?: string } }).object?.sha;
        }
        if (!sha) return { success: false, error: 'Could not resolve source SHA' };
        const res = await githubFetch(
          `/repos/${p.owner}/${p.repo}/git/refs`,
          token,
          { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${p.branch}`, sha }) },
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        return { success: true, data: { branch: p.branch, sha } };
      }

      case 'github.delete_branch': {
        const p = deleteBranch.params.parse(params);
        const res = await githubFetch(
          `/repos/${p.owner}/${p.repo}/git/refs/heads/${p.branch}`,
          token,
          { method: 'DELETE' },
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        return { success: true, data: { deleted: p.branch } };
      }

      case 'github.list_commits': {
        const p = listCommits.params.parse(params);
        const qs = new URLSearchParams();
        if (p.sha) qs.set('sha', p.sha);
        if (p.path) qs.set('path', p.path);
        if (p.author) qs.set('author', p.author);
        qs.set('per_page', String(Math.min(Math.max(p.limit ?? 30, 1), 100)));
        const res = await githubFetch(`/repos/${p.owner}/${p.repo}/commits?${qs}`, token);
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const commits = (await res.json()) as Array<Record<string, unknown>>;
        return {
          success: true,
          data: commits.map((c) => ({
            sha: c.sha,
            message: ((c.commit as Record<string, unknown>)?.message as string)?.split('\n')[0],
            author: ((c.commit as Record<string, unknown>)?.author as Record<string, unknown>)?.name,
            date: ((c.commit as Record<string, unknown>)?.author as Record<string, unknown>)?.date,
            url: c.html_url,
          })),
        };
      }

      case 'github.search_code': {
        const p = searchCode.params.parse(params);
        const limit = Math.min(Math.max(p.limit ?? 30, 1), 100);
        const res = await githubFetch(
          `/search/code?q=${encodeURIComponent(p.q)}&per_page=${limit}`,
          token,
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const data = await res.json() as { total_count?: number; items?: Array<Record<string, unknown>> };
        return {
          success: true,
          data: {
            total_count: data.total_count,
            items: (data.items ?? []).map((item) => ({
              name: item.name,
              path: item.path,
              repo: (item.repository as Record<string, unknown>)?.full_name,
              url: item.html_url,
            })),
          },
        };
      }

      case 'github.search_issues': {
        const p = searchIssues.params.parse(params);
        const limit = Math.min(Math.max(p.limit ?? 30, 1), 100);
        const qs = new URLSearchParams({ q: p.q, per_page: String(limit) });
        if (p.sort) qs.set('sort', p.sort);
        if (p.order) qs.set('order', p.order);
        const res = await githubFetch(`/search/issues?${qs}`, token);
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const data = await res.json() as { total_count?: number; items?: Array<Record<string, unknown>> };
        return {
          success: true,
          data: {
            total_count: data.total_count,
            items: (data.items ?? []).map((item) => ({
              number: item.number,
              title: item.title,
              state: item.state,
              user: (item.user as Record<string, unknown>)?.login,
              url: item.html_url,
              is_pr: !!item.pull_request,
              labels: (item.labels as Array<Record<string, unknown>>)?.map((l) => l.name),
              created_at: item.created_at,
              updated_at: item.updated_at,
            })),
          },
        };
      }

      case 'github.create_release': {
        const p = createRelease.params.parse(params);
        const body: Record<string, unknown> = { tag_name: p.tagName };
        if (p.name !== undefined) body.name = p.name;
        if (p.body !== undefined) body.body = p.body;
        if (p.targetCommitish !== undefined) body.target_commitish = p.targetCommitish;
        if (p.draft !== undefined) body.draft = p.draft;
        if (p.prerelease !== undefined) body.prerelease = p.prerelease;
        if (p.generateReleaseNotes !== undefined) body.generate_release_notes = p.generateReleaseNotes;
        const res = await githubFetch(
          `/repos/${p.owner}/${p.repo}/releases`,
          token,
          { method: 'POST', body: JSON.stringify(body) },
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const release = await res.json() as Record<string, unknown>;
        return { success: true, data: { id: release.id, tag: release.tag_name, url: release.html_url, draft: release.draft, prerelease: release.prerelease } };
      }

      case 'github.fork_repository': {
        const p = forkRepository.params.parse(params);
        const body: Record<string, unknown> = {};
        if (p.organization) body.organization = p.organization;
        if (p.name) body.name = p.name;
        const res = await githubFetch(
          `/repos/${p.owner}/${p.repo}/forks`,
          token,
          { method: 'POST', body: JSON.stringify(body) },
        );
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const fork = await res.json() as Record<string, unknown>;
        return { success: true, data: { full_name: fork.full_name, url: fork.html_url, clone_url: fork.clone_url } };
      }

      case 'github.list_workflow_runs': {
        const p = listWorkflowRuns.params.parse(params);
        const qs = new URLSearchParams();
        if (p.branch) qs.set('branch', p.branch);
        if (p.status) qs.set('status', p.status);
        if (p.event) qs.set('event', p.event);
        qs.set('per_page', String(Math.min(Math.max(p.limit ?? 30, 1), 100)));
        const res = await githubFetch(`/repos/${p.owner}/${p.repo}/actions/runs?${qs}`, token);
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const data = await res.json() as { total_count?: number; workflow_runs?: Array<Record<string, unknown>> };
        return {
          success: true,
          data: {
            total_count: data.total_count,
            runs: (data.workflow_runs ?? []).map((r) => ({
              id: r.id,
              name: r.name,
              status: r.status,
              conclusion: r.conclusion,
              branch: (r.head_branch as string),
              event: r.event,
              url: r.html_url,
              created_at: r.created_at,
            })),
          },
        };
      }

      case 'github.create_repository': {
        const p = createRepository.params.parse(params);
        const body: Record<string, unknown> = { name: p.name };
        if (p.description !== undefined) body.description = p.description;
        if (p.private !== undefined) body.private = p.private;
        if (p.autoInit !== undefined) body.auto_init = p.autoInit;
        if (p.gitignoreTemplate !== undefined) body.gitignore_template = p.gitignoreTemplate;
        if (p.licenseTemplate !== undefined) body.license_template = p.licenseTemplate;
        const res = await githubFetch('/user/repos', token, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) return { success: false, error: `GitHub API error (${res.status}): ${await res.text()}` };
        const repo = await res.json() as Record<string, unknown>;
        return { success: true, data: { full_name: repo.full_name, url: repo.html_url, clone_url: repo.clone_url, private: repo.private } };
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
