/**
 * Shared utilities for GitHub repo providers (OAuth + App).
 */
import type { RepoCredential, RepoValidation } from '@valet/sdk/repos';
import { githubFetch } from './actions/api.js';

// ─── URL Patterns ────────────────────────────────────────────────────────────

export const GITHUB_URL_PATTERNS: RegExp[] = [/github\.com/];

// ─── Exported Utilities ──────────────────────────────────────────────────────

export function mapGitHubRepo(r: any) {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    url: r.html_url,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    private: r.private,
    description: r.description ?? null,
    updatedAt: r.updated_at,
    language: r.language ?? null,
  };
}

export async function validateGitHubRepo(
  credential: RepoCredential,
  repoUrl: string,
): Promise<RepoValidation> {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return { accessible: false, error: 'Invalid GitHub URL' };
  const [, owner, repo] = match;
  if (!credential.accessToken) {
    return { accessible: false, error: 'No access token available — mint a token first' };
  }
  const res = await githubFetch(`/repos/${owner}/${repo}`, credential.accessToken);
  if (!res.ok) return { accessible: false, error: `Repository not accessible: ${res.status}` };
  const data = (await res.json()) as {
    full_name: string;
    default_branch: string;
    private: boolean;
    clone_url: string;
    permissions?: { push: boolean; pull: boolean; admin: boolean };
  };
  return {
    accessible: true,
    permissions: data.permissions || { push: false, pull: true, admin: false },
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: data.private,
    cloneUrl: data.clone_url,
  };
}
