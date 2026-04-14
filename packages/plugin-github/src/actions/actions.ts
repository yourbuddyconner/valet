import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { Octokit } from 'octokit';

// ─── Octokit + Attribution Helpers ──────────────────────────────────────────

function getOctokit(ctx: ActionContext): Octokit {
  const token = ctx.credentials.access_token || ctx.credentials.token;
  if (!token) throw new Error('Missing access token');
  return new Octokit({ auth: token });
}

/** Bot-token discriminator: attribution present = bot token. */
function isBotToken(ctx: ActionContext): boolean {
  return !!ctx.attribution;
}

/** Suffix for PR/issue bodies when acting under a bot token. */
function attributionSuffix(ctx: ActionContext): string {
  if (!ctx.attribution) return '';
  return `\n\n---\n> Created on behalf of ${ctx.attribution.name} <${ctx.attribution.email}>`;
}

/** Trailer for commit messages when acting under a bot token. */
function attributionCommitTrailer(ctx: ActionContext): string {
  if (!ctx.attribution) return '';
  return `\n\nCo-Authored-By: ${ctx.attribution.name} <${ctx.attribution.email}>`;
}

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
  description: 'List repositories accessible to the authenticated credential.',
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

// ─── Permission hints for 403 errors ─────────────────────────────────────────

const PERMISSION_HINTS: Record<string, string> = {
  'github.list_workflow_runs': 'actions:read',
  'github.create_issue': 'issues:write',
  'github.update_issue': 'issues:write',
  'github.create_comment': 'issues:write',
  'github.create_pull_request': 'pull_requests:write',
  'github.update_pull_request': 'pull_requests:write',
  'github.merge_pull_request': 'pull_requests:write + contents:write',
  'github.create_branch': 'contents:write',
  'github.delete_branch': 'contents:write',
  'github.create_release': 'contents:write',
  'github.inspect_pull_request': 'pull_requests:read (+ checks:read for check runs)',
  'github.fork_repository': 'contents:write',
};

function handleOctokitError(err: any, actionId: string, operation: string): ActionResult {
  const status = err.status ?? 'unknown';
  if (status === 403) {
    const hint = PERMISSION_HINTS[actionId];
    const permMsg = hint
      ? ` This action requires the "${hint}" permission on the GitHub App. Ask an admin to update the App's permissions in Settings > GitHub.`
      : '';
    return { success: false, error: `${operation}: GitHub returned 403 Forbidden.${permMsg}` };
  }
  return { success: false, error: `${operation}: ${status} ${err.message}` };
}

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const octokit = getOctokit(ctx);

  try {
    switch (actionId) {
      case 'github.get_repository': {
        const { owner, repo } = getRepository.params.parse(params);
        try {
          const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
          return { success: true, data };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Get repository');
        }
      }

      case 'github.list_repos': {
        const p = listRepos.params.parse(params);
        try {
          if (isBotToken(ctx)) {
            const { data } = await octokit.request('GET /installation/repositories', {
              sort: p.sort, per_page: p.perPage, page: p.page,
            });
            return { success: true, data: data.repositories };
          }
          const { data } = await octokit.request('GET /user/repos', {
            sort: p.sort, per_page: p.perPage, page: p.page,
          });
          return { success: true, data };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'List repos');
        }
      }

      case 'github.get_issue': {
        const { owner, repo, issueNumber } = getIssue.params.parse(params);
        try {
          const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner, repo, issue_number: issueNumber,
          });
          return { success: true, data };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Get issue');
        }
      }

      case 'github.create_issue': {
        const p = createIssue.params.parse(params);
        const finalBody = (p.body ?? '') + attributionSuffix(ctx);
        try {
          const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
            owner: p.owner, repo: p.repo, title: p.title,
            body: finalBody || undefined,
          });
          return { success: true, data };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Create issue');
        }
      }

      case 'github.get_pull_request': {
        const { owner, repo, pullNumber } = getPullRequest.params.parse(params);
        try {
          const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner, repo, pull_number: pullNumber,
          });
          return { success: true, data };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Get pull request');
        }
      }

      case 'github.create_comment': {
        const { owner, repo, issueNumber, body } = createComment.params.parse(params);
        try {
          const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner, repo, issue_number: issueNumber, body,
          });
          return { success: true, data };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Create comment');
        }
      }

      case 'github.list_pull_requests': {
        const p = listPullRequests.params.parse(params);
        const state = p.state || 'open';
        const limit = Math.min(Math.max(p.limit ?? 30, 1), 100);
        try {
          const { data: pulls } = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner: p.owner, repo: p.repo, state, sort: 'updated',
            direction: 'desc', per_page: limit,
          });
          return {
            success: true,
            data: pulls.map((pr) => ({
              number: pr.number,
              title: pr.title,
              state: pr.state,
              user: pr.user?.login,
              url: pr.html_url,
              draft: pr.draft,
              created_at: pr.created_at,
              updated_at: pr.updated_at,
              head: pr.head?.ref,
              base: pr.base?.ref,
            })),
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'List pull requests');
        }
      }

      case 'github.inspect_pull_request': {
        const p = inspectPullRequest.params.parse(params);
        const filesLimit = Math.min(Math.max(p.filesLimit ?? 100, 1), 300);
        const commentsLimit = Math.min(Math.max(p.commentsLimit ?? 100, 1), 300);

        try {
          // Fetch PR, files, reviews, comments in parallel
          const [prResp, filesResp, reviewsResp, commentsResp] = await Promise.all([
            octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
              owner: p.owner, repo: p.repo, pull_number: p.pullNumber,
            }),
            octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
              owner: p.owner, repo: p.repo, pull_number: p.pullNumber, per_page: filesLimit,
            }).catch(() => ({ data: [] as any[] })),
            octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
              owner: p.owner, repo: p.repo, pull_number: p.pullNumber,
            }).catch(() => ({ data: [] as any[] })),
            octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
              owner: p.owner, repo: p.repo, pull_number: p.pullNumber, per_page: commentsLimit,
            }).catch(() => ({ data: [] as any[] })),
          ]);

          const pr = prResp.data;
          const files = filesResp.data;
          const reviews = reviewsResp.data;
          const comments = commentsResp.data;

          // Get check runs for the head SHA
          const headSha = pr.head?.sha || '';
          let checks: any[] = [];
          if (headSha) {
            try {
              const checksResp = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
                owner: p.owner, repo: p.repo, ref: headSha,
              });
              checks = checksResp.data.check_runs ?? [];
            } catch {
              // silently skip if check runs fail
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
              user: pr.user?.login,
              url: pr.html_url,
              head: { ref: pr.head?.ref, sha: headSha },
              base: { ref: pr.base?.ref },
              body: pr.body,
              additions: pr.additions,
              deletions: pr.deletions,
              changed_files: pr.changed_files,
              files: files.map((f: any) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
              })),
              reviews: reviews.filter((r: any) => r.state !== 'DISMISSED').map((r: any) => ({
                user: r.user?.login,
                state: r.state,
                body: r.body,
              })),
              comments: comments.map((c: any) => ({
                user: c.user?.login,
                path: c.path,
                line: c.line ?? c.original_line,
                body: c.body,
              })),
              checks: checks.map((c: any) => ({
                name: c.name,
                status: c.status,
                conclusion: c.conclusion,
              })),
            },
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Inspect pull request');
        }
      }

      case 'github.update_pull_request': {
        const p = updatePullRequest.params.parse(params);
        const updateBody: Record<string, unknown> = {};
        if (p.title !== undefined) updateBody.title = p.title;
        if (p.body !== undefined) updateBody.body = p.body + attributionSuffix(ctx);
        if (p.state !== undefined) updateBody.state = p.state;

        try {
          const { data: prData } = await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: p.owner, repo: p.repo, pull_number: p.pullNumber,
            ...updateBody,
          });

          // Set labels separately if provided
          if (p.labels) {
            await octokit.request('PUT /repos/{owner}/{repo}/issues/{issue_number}/labels', {
              owner: p.owner, repo: p.repo, issue_number: p.pullNumber,
              labels: p.labels,
            });
          }

          return { success: true, data: { number: prData.number, url: prData.html_url, title: prData.title, state: prData.state } };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Update pull request');
        }
      }

      case 'github.list_issues': {
        const p = listIssues.params.parse(params);
        const limit = Math.min(Math.max(p.limit ?? 30, 1), 100);

        try {
          const { data: issues } = await octokit.request('GET /repos/{owner}/{repo}/issues', {
            owner: p.owner, repo: p.repo,
            state: p.state as 'open' | 'closed' | 'all' | undefined,
            labels: p.labels, assignee: p.assignee,
            sort: p.sort, direction: p.direction,
            // Fetch max page size since GitHub's issues endpoint includes PRs which we filter out
            per_page: 100,
          });
          return {
            success: true,
            data: issues
              .filter((i) => !i.pull_request) // exclude PRs from issue list
              .slice(0, limit)
              .map((i) => ({
                number: i.number,
                title: i.title,
                state: i.state,
                user: i.user?.login,
                url: i.html_url,
                labels: (i.labels as Array<any>)?.map((l: any) => typeof l === 'string' ? l : l.name),
                assignees: i.assignees?.map((a) => a.login),
                created_at: i.created_at,
                updated_at: i.updated_at,
              })),
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'List issues');
        }
      }

      case 'github.update_issue': {
        const p = updateIssue.params.parse(params);
        const updateBody: Record<string, unknown> = {};
        if (p.title !== undefined) updateBody.title = p.title;
        if (p.body !== undefined) updateBody.body = p.body + attributionSuffix(ctx);
        if (p.state !== undefined) updateBody.state = p.state;
        if (p.labels !== undefined) updateBody.labels = p.labels;
        if (p.assignees !== undefined) updateBody.assignees = p.assignees;

        try {
          const { data: issue } = await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
            owner: p.owner, repo: p.repo, issue_number: p.issueNumber,
            ...updateBody,
          });
          return { success: true, data: { number: issue.number, url: issue.html_url, title: issue.title, state: issue.state } };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Update issue');
        }
      }

      case 'github.create_pull_request': {
        const p = createPullRequest.params.parse(params);
        const finalBody = (p.body ?? '') + attributionSuffix(ctx);
        try {
          const { data: pr } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner: p.owner, repo: p.repo,
            title: p.title, head: p.head, base: p.base,
            body: finalBody || undefined,
            draft: p.draft,
          });
          return { success: true, data: { number: pr.number, url: pr.html_url, title: pr.title, state: pr.state, draft: pr.draft } };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Create pull request');
        }
      }

      case 'github.merge_pull_request': {
        const p = mergePullRequest.params.parse(params);
        const commitMessage = p.commitMessage
          ? p.commitMessage + attributionCommitTrailer(ctx)
          : undefined;
        try {
          const { data } = await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
            owner: p.owner, repo: p.repo, pull_number: p.pullNumber,
            merge_method: p.mergeMethod,
            commit_title: p.commitTitle,
            commit_message: commitMessage,
          });
          return { success: true, data: { merged: data.merged, message: data.message, sha: data.sha } };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Merge pull request');
        }
      }

      case 'github.create_branch': {
        const p = createBranch.params.parse(params);
        let sha: string | undefined;

        try {
          if (p.fromRef) {
            // Try as branch name
            try {
              const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
                owner: p.owner, repo: p.repo, ref: `heads/${p.fromRef}`,
              });
              sha = data.object?.sha;
            } catch {
              // Try as tag
              try {
                const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
                  owner: p.owner, repo: p.repo, ref: `tags/${p.fromRef}`,
                });
                sha = data.object?.sha;
              } catch {
                // Try as raw commit SHA
                try {
                  await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
                    owner: p.owner, repo: p.repo, commit_sha: p.fromRef,
                  });
                  sha = p.fromRef;
                } catch {
                  // none matched
                }
              }
            }
            if (!sha) return { success: false, error: `Could not resolve ref "${p.fromRef}"` };
          } else {
            // Discover repo default branch
            const { data: repoData } = await octokit.request('GET /repos/{owner}/{repo}', {
              owner: p.owner, repo: p.repo,
            });
            const defaultBranch = repoData.default_branch || 'main';
            const { data: refData } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
              owner: p.owner, repo: p.repo, ref: `heads/${defaultBranch}`,
            });
            sha = refData.object?.sha;
          }
          if (!sha) return { success: false, error: 'Could not resolve source SHA' };

          await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
            owner: p.owner, repo: p.repo,
            ref: `refs/heads/${p.branch}`, sha,
          });
          return { success: true, data: { branch: p.branch, sha } };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Create branch');
        }
      }

      case 'github.delete_branch': {
        const p = deleteBranch.params.parse(params);
        try {
          await octokit.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
            owner: p.owner, repo: p.repo, ref: `heads/${p.branch}`,
          });
          return { success: true, data: { deleted: p.branch } };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Delete branch');
        }
      }

      case 'github.list_commits': {
        const p = listCommits.params.parse(params);
        const perPage = Math.min(Math.max(p.limit ?? 30, 1), 100);
        try {
          const { data: commits } = await octokit.request('GET /repos/{owner}/{repo}/commits', {
            owner: p.owner, repo: p.repo,
            sha: p.sha, path: p.path, author: p.author, per_page: perPage,
          });
          return {
            success: true,
            data: commits.map((c) => ({
              sha: c.sha,
              message: c.commit?.message?.split('\n')[0],
              author: c.commit?.author?.name,
              date: c.commit?.author?.date,
              url: c.html_url,
            })),
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'List commits');
        }
      }

      case 'github.search_code': {
        const p = searchCode.params.parse(params);
        const limit = Math.min(Math.max(p.limit ?? 30, 1), 100);
        try {
          const { data } = await octokit.request('GET /search/code', {
            q: p.q, per_page: limit,
          });
          return {
            success: true,
            data: {
              total_count: data.total_count,
              items: data.items.map((item) => ({
                name: item.name,
                path: item.path,
                repo: item.repository?.full_name,
                url: item.html_url,
              })),
            },
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Search code');
        }
      }

      case 'github.search_issues': {
        const p = searchIssues.params.parse(params);
        const limit = Math.min(Math.max(p.limit ?? 30, 1), 100);
        try {
          const { data } = await octokit.request('GET /search/issues', {
            q: p.q, per_page: limit, sort: p.sort, order: p.order,
          });
          return {
            success: true,
            data: {
              total_count: data.total_count,
              items: data.items.map((item) => ({
                number: item.number,
                title: item.title,
                state: item.state,
                user: item.user?.login,
                url: item.html_url,
                is_pr: !!item.pull_request,
                labels: (item.labels as Array<any>)?.map((l: any) => typeof l === 'string' ? l : l.name),
                created_at: item.created_at,
                updated_at: item.updated_at,
              })),
            },
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Search issues');
        }
      }

      case 'github.create_release': {
        const p = createRelease.params.parse(params);
        try {
          const { data: release } = await octokit.request('POST /repos/{owner}/{repo}/releases', {
            owner: p.owner, repo: p.repo,
            tag_name: p.tagName,
            name: p.name,
            body: p.body,
            target_commitish: p.targetCommitish,
            draft: p.draft,
            prerelease: p.prerelease,
            generate_release_notes: p.generateReleaseNotes,
          });
          return { success: true, data: { id: release.id, tag: release.tag_name, url: release.html_url, draft: release.draft, prerelease: release.prerelease } };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Create release');
        }
      }

      case 'github.fork_repository': {
        if (isBotToken(ctx)) {
          return { success: false, error: 'Forking repositories requires a personal GitHub OAuth token. GitHub App installation tokens cannot fork repositories. Ask the user to connect their personal GitHub account in Settings > Integrations.' };
        }
        const p = forkRepository.params.parse(params);
        try {
          const { data: fork } = await octokit.request('POST /repos/{owner}/{repo}/forks', {
            owner: p.owner, repo: p.repo,
            organization: p.organization,
            name: p.name,
          });
          return { success: true, data: { full_name: fork.full_name, url: fork.html_url, clone_url: fork.clone_url } };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Fork repository');
        }
      }

      case 'github.list_workflow_runs': {
        const p = listWorkflowRuns.params.parse(params);
        const perPage = Math.min(Math.max(p.limit ?? 30, 1), 100);
        try {
          const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
            owner: p.owner, repo: p.repo,
            branch: p.branch, status: p.status, event: p.event, per_page: perPage,
          });
          return {
            success: true,
            data: {
              total_count: data.total_count,
              runs: data.workflow_runs.map((r) => ({
                id: r.id,
                name: r.name,
                status: r.status,
                conclusion: r.conclusion,
                branch: r.head_branch,
                event: r.event,
                url: r.html_url,
                created_at: r.created_at,
              })),
            },
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'List workflow runs');
        }
      }

      case 'github.create_repository': {
        const p = createRepository.params.parse(params);
        try {
          const { data: repo } = await octokit.request('POST /user/repos', {
            name: p.name,
            description: p.description,
            private: p.private,
            auto_init: p.autoInit,
            gitignore_template: p.gitignoreTemplate,
            license_template: p.licenseTemplate,
          });
          return { success: true, data: { full_name: repo.full_name, url: repo.html_url, clone_url: repo.clone_url, private: repo.private } };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Create repository');
        }
      }

      case 'github.read_repo_file': {
        const p = readRepoFile.params.parse(params);
        try {
          const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: p.owner, repo: p.repo, path: p.path,
            ref: p.ref,
          });

          if (Array.isArray(data) || data.type !== 'file') {
            return { success: false, error: `Path is a ${Array.isArray(data) ? 'directory' : (data as any).type}, not a file` };
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
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Read repo file');
        }
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
