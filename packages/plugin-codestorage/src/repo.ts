import type {
  RepoProvider,
  RepoCredential,
  RepoList,
  RepoValidation,
} from '@valet/sdk/repos';

const CODESTORAGE_URL_RE = /(?:https?:\/\/)?(?:[^@]+@)?([a-z0-9._-]+\.code\.storage)\/(.+?)(?:\.git)?$/i;

type ParsedRepoUrl = {
  host: string;
  path: string;
  cloneUrl: string;
};

function parseCodeStorageRepoUrl(repoUrl: string): ParsedRepoUrl | null {
  const normalized = repoUrl.trim();
  const match = normalized.match(CODESTORAGE_URL_RE);
  if (!match) return null;

  const host = match[1];
  const path = match[2].replace(/^\/+/, '');
  return {
    host,
    path,
    cloneUrl: `https://${host}/${path}.git`,
  };
}

function withCodeStorageUsername(url: string): string {
  // code.storage docs use username "t" with bearer/password token auth.
  // Keep this in the URL to ensure git credential lookups include a username.
  return url.replace(/^https:\/\//i, 'https://t@');
}

function parseApiBase(credential: RepoCredential): string {
  const explicit = credential.metadata?.apiBase || credential.metadata?.api_base;
  if (explicit) return explicit.replace(/\/$/, '');

  const issuer = credential.metadata?.issuer;
  if (issuer) return `https://api.${issuer}.code.storage/api/v1`;

  return '';
}

function asToken(credential: RepoCredential): string {
  const token = credential.accessToken || credential.metadata?.token || credential.metadata?.access_token;
  if (!token) throw new Error('code.storage repo provider requires an access token');
  return token;
}

async function codestorageFetch(apiBase: string, path: string, token: string): Promise<Response> {
  return fetch(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'Valet',
    },
  });
}

export const codestorageRepoProvider: RepoProvider = {
  id: 'codestorage',
  displayName: 'code.storage',
  icon: 'package',
  supportsOrgLevel: true,
  supportsPersonalLevel: true,
  urlPatterns: [/\.code\.storage\//i],

  async listRepos(credential: RepoCredential, opts?): Promise<RepoList> {
    const apiBase = parseApiBase(credential);
    const token = asToken(credential);

    // Initial backend-first support: if API base isn't configured yet,
    // skip list UX gracefully while clone/push remains fully supported.
    if (!apiBase) return { repos: [], hasMore: false };

    const page = opts?.page || 1;
    const limit = 30;
    const q = opts?.search?.trim();
    const query = new URLSearchParams({ limit: String(limit), page: String(page) });
    if (q) query.set('q', q);

    const res = await codestorageFetch(apiBase, `/repos?${query.toString()}`, token);
    if (!res.ok) {
      throw new Error(`code.storage list repos failed: ${res.status}`);
    }

    const data = (await res.json()) as { items?: any[]; repos?: any[]; nextCursor?: string; hasMore?: boolean };
    const repos = (data.items || data.repos || []).map((r: any) => {
      const fullName = r.full_name || r.fullName || r.name || '';
      const parsed = parseCodeStorageRepoUrl(r.clone_url || r.cloneUrl || r.url || '');
      return {
        id: typeof r.id === 'number' ? r.id : undefined,
        name: r.name || fullName.split('/').pop() || fullName,
        fullName,
        url: r.url || (parsed ? parsed.cloneUrl.replace(/\.git$/, '') : ''),
        cloneUrl: r.clone_url || r.cloneUrl || parsed?.cloneUrl || '',
        defaultBranch: r.default_branch || r.defaultBranch || 'main',
        private: r.private ?? true,
        description: r.description ?? null,
        updatedAt: r.updated_at || r.updatedAt,
        language: r.language ?? null,
      };
    }).filter((r: any) => r.fullName && r.cloneUrl);

    return {
      repos,
      hasMore: Boolean(data.hasMore || data.nextCursor || repos.length === limit),
    };
  },

  async validateRepo(credential: RepoCredential, repoUrl: string): Promise<RepoValidation> {
    const parsed = parseCodeStorageRepoUrl(repoUrl);
    if (!parsed) {
      return { accessible: false, error: 'Invalid code.storage repository URL' };
    }

    const apiBase = parseApiBase(credential);
    const token = asToken(credential);

    if (!apiBase) {
      // Bootstrap mode: no API base configured, so we can't verify the repo
      // server-side. We accept the URL if it parses and a token exists. A typo'd
      // URL or revoked token will surface as a clone-time error, which is acceptable
      // for this initial backend-first rollout — full validation requires apiBase
      // (derived from credential metadata) to be configured.
      return {
        accessible: true,
        permissions: { push: true, pull: true, admin: false },
        fullName: parsed.path,
        defaultBranch: 'main',
        private: true,
        cloneUrl: parsed.cloneUrl,
      };
    }

    const encodedPath = encodeURIComponent(parsed.path);
    const res = await codestorageFetch(apiBase, `/repos/${encodedPath}`, token);
    if (!res.ok) {
      return { accessible: false, error: `Repository not accessible: ${res.status}` };
    }

    const data = (await res.json()) as {
      full_name?: string;
      default_branch?: string;
      private?: boolean;
      clone_url?: string;
      permissions?: { push?: boolean; pull?: boolean; admin?: boolean };
    };

    return {
      accessible: true,
      permissions: {
        push: data.permissions?.push ?? true,
        pull: data.permissions?.pull ?? true,
        admin: data.permissions?.admin ?? false,
      },
      fullName: data.full_name || parsed.path,
      defaultBranch: data.default_branch || 'main',
      private: data.private ?? true,
      cloneUrl: data.clone_url || parsed.cloneUrl,
    };
  },

  async assembleSessionEnv(_credential: RepoCredential, opts) {
    // Note: the minted token is not embedded here. The Runner's git-setup.ts
    // configures a global git credential.helper that calls back to the Runner
    // gateway (/git/credentials), which invokes mintToken() on-demand. The t@
    // username in the clone URL ensures git triggers a credential lookup.
    const parsed = parseCodeStorageRepoUrl(opts.repoUrl);
    if (!parsed) {
      throw new Error('Invalid code.storage repository URL');
    }

    return {
      envVars: {
        REPO_URL: withCodeStorageUsername(parsed.cloneUrl),
        ...(opts.branch ? { REPO_BRANCH: opts.branch } : {}),
        ...(opts.ref ? { REPO_REF: opts.ref } : {}),
      },
      gitConfig: {
        'user.name': opts.gitUser.name,
        'user.email': opts.gitUser.email,
      },
    };
  },

  async mintToken(credential: RepoCredential) {
    const token = asToken(credential);
    return {
      accessToken: token,
      expiresAt: credential.expiresAt,
    };
  },
};
