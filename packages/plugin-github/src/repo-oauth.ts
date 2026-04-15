import type { RepoProvider, RepoCredential } from '@valet/sdk/repos';
import { githubFetch } from './actions/api.js';
import { GITHUB_URL_PATTERNS, mapGitHubRepo, validateGitHubRepo } from './repo-shared.js';

export const githubUserRepoProvider: RepoProvider = {
  id: 'github-user',
  displayName: 'GitHub (Personal)',
  icon: 'github',
  supportsOrgLevel: false,
  supportsPersonalLevel: true,
  urlPatterns: GITHUB_URL_PATTERNS,

  async listRepos(credential: RepoCredential, opts?) {
    if (!credential.accessToken) {
      throw new Error('GitHub repo listing requires an access token');
    }
    const token = credential.accessToken;
    const page = opts?.page || 1;
    const search = opts?.search;

    if (search) {
      const res = await githubFetch(
        `/search/repositories?q=${encodeURIComponent(search)}+in:name&per_page=30&page=${page}`,
        token,
      );
      const data = (await res.json()) as { items: any[]; total_count: number };
      return {
        repos: data.items.map(mapGitHubRepo),
        hasMore: data.total_count > page * 30,
      };
    }

    const res = await githubFetch(
      `/user/repos?per_page=30&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      token,
    );
    const repos = (await res.json()) as any[];
    return {
      repos: repos.map(mapGitHubRepo),
      hasMore: repos.length === 30,
    };
  },

  validateRepo: validateGitHubRepo,

  async assembleSessionEnv(credential, opts) {
    const gitName = credential.metadata?.attribution_name ?? opts.gitUser.name;
    const gitEmail = credential.metadata?.attribution_email ?? opts.gitUser.email;
    return {
      envVars: {
        REPO_URL: opts.repoUrl,
        ...(opts.branch ? { REPO_BRANCH: opts.branch } : {}),
        ...(opts.ref ? { REPO_REF: opts.ref } : {}),
      },
      gitConfig: {
        'user.name': gitName,
        'user.email': gitEmail,
      },
    };
  },

  async mintToken(credential) {
    // User OAuth tokens are already valid — just pass through.
    // Refresh is handled by the credential service, not here.
    if (!credential.accessToken) {
      throw new Error('No access token available');
    }
    return { accessToken: credential.accessToken, expiresAt: credential.expiresAt };
  },
};
