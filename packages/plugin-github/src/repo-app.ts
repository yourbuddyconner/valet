import type { RepoProvider, RepoCredential } from '@valet/sdk/repos';
import { githubFetch } from './actions/api.js';
import { GITHUB_URL_PATTERNS, mapGitHubRepo, validateGitHubRepo } from './repo-shared.js';

export const githubAppRepoProvider: RepoProvider = {
  id: 'github-app',
  displayName: 'GitHub (App)',
  icon: 'github',
  supportsOrgLevel: true,
  supportsPersonalLevel: false,
  urlPatterns: GITHUB_URL_PATTERNS,

  async listRepos(credential: RepoCredential, opts?) {
    if (!credential.accessToken) {
      throw new Error('GitHub repo listing requires an access token — mint a token first');
    }
    const token = credential.accessToken;
    const page = opts?.page || 1;
    const search = opts?.search;

    if (search) {
      // Note: /search/repositories may return repos outside the App's installation scope.
      // Installation tokens limit write access but search results are not filtered.
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
      `/installation/repositories?per_page=30&page=${page}`,
      token,
    );
    const data = (await res.json()) as { repositories: any[]; total_count: number };
    return {
      repos: data.repositories.map(mapGitHubRepo),
      hasMore: data.total_count > page * 30,
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
    // Under the unified App model, installation tokens are minted on-demand
    // by env-assembly and passed in via credential.accessToken.
    if (!credential.accessToken) {
      throw new Error('No access token available — installation token should be pre-minted');
    }
    return { accessToken: credential.accessToken, expiresAt: credential.expiresAt };
  },
};
