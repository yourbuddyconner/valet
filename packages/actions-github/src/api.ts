const GITHUB_API = 'https://api.github.com';

/** Stateless authenticated fetch against the GitHub API. */
export async function githubFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Valet/1.0',
      ...options?.headers,
    },
  });
}
