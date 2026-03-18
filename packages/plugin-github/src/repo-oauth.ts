import type { RepoProvider, RepoCredential } from '@valet/sdk/repos';
import { githubFetch } from './actions/api.js';
import { GITHUB_URL_PATTERNS, mapGitHubRepo, validateGitHubRepo } from './repo-shared.js';

export const githubOAuthRepoProvider: RepoProvider = {
  id: 'github-oauth',
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
    return {
      envVars: {
        REPO_URL: opts.repoUrl,
        ...(opts.branch ? { REPO_BRANCH: opts.branch } : {}),
        ...(opts.ref ? { REPO_REF: opts.ref } : {}),
      },
      gitConfig: {
        'user.name': opts.gitUser.name,
        'user.email': opts.gitUser.email,
      },
    };
  },

  async mintToken(credential) {
    if (!credential.accessToken) {
      throw new Error('OAuth credential has no access token');
    }
    return { accessToken: credential.accessToken, expiresAt: credential.expiresAt };
  },
};
