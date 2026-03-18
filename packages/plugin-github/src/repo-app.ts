import type { RepoProvider, RepoCredential, RepoList } from '@valet/sdk/repos';
import { githubFetch } from './actions/api.js';
import { GITHUB_URL_PATTERNS, mapGitHubRepo, mintInstallationToken, validateGitHubRepo } from './repo-shared.js';

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
    return {
      envVars: {
        REPO_URL: opts.repoUrl,
        ...(opts.branch ? { REPO_BRANCH: opts.branch } : {}),
        ...(opts.ref ? { REPO_REF: opts.ref } : {}),
      },
      gitConfig: {
        'user.name': 'valet[bot]',
        'user.email': 'valet[bot]@users.noreply.github.com',
      },
    };
  },

  async mintToken(credential) {
    if (!credential.installationId) {
      throw new Error('Cannot mint token without installationId');
    }
    const appId = credential.metadata?.appId || credential.metadata?.app_id;
    const privateKey = credential.metadata?.privateKey || credential.metadata?.private_key;
    if (!appId || !privateKey) {
      throw new Error('GitHub App credentials (appId, privateKey) not found in credential');
    }
    const result = await mintInstallationToken(credential.installationId, appId, privateKey);
    return { accessToken: result.token, expiresAt: result.expiresAt };
  },
};
