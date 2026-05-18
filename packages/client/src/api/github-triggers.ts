import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './client';

export interface AvailableEventsResponse {
  events: string[];
  byRepo: Record<string, string[]>;
  notInstalled?: string[];
}

const EMPTY: AvailableEventsResponse = { events: [], byRepo: {} };

/**
 * Fetch the GitHub events the App can deliver for the given repos.
 *
 * Endpoint: `GET /api/triggers/github/available-events?repo=owner/name[&repo=...]`
 * With no repos, the API returns the App-level subscription as a default so the
 * form can show options before a repo is selected.
 *
 * Defensive: if the endpoint isn't deployed yet (404), we treat it as "no
 * events available" so the dialog can render a helpful empty state instead of
 * crashing. Other errors are surfaced via the query's `error` state.
 */
export function useGitHubAvailableEvents(repos: string[]) {
  // Sort for stable query cache: ['a','b'] and ['b','a'] should share a key.
  const sortedRepos = [...repos].sort();
  return useQuery<AvailableEventsResponse>({
    queryKey: ['github-available-events', sortedRepos],
    queryFn: async () => {
      const params = sortedRepos
        .map((r) => `repo=${encodeURIComponent(r)}`)
        .join('&');
      const url = params
        ? `/triggers/github/available-events?${params}`
        : '/triggers/github/available-events';
      try {
        return await api.get<AvailableEventsResponse>(url);
      } catch (err) {
        // The foundation API may not be deployed yet — degrade gracefully so
        // the form still renders an actionable empty state.
        if (err instanceof ApiError && err.status === 404) {
          return EMPTY;
        }
        throw err;
      }
    },
    staleTime: 60_000,
  });
}
