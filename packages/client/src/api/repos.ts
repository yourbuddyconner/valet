import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface Repo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt: string;
  language: string | null;
}

interface ReposResponse {
  repos: Repo[];
  page: number;
  perPage: number;
}

interface ValidateRepoResponse {
  valid: boolean;
  error?: string;
  repo?: {
    fullName: string;
    defaultBranch: string;
    private: boolean;
    canPush: boolean;
    cloneUrl: string;
  };
}

export interface RepoPull {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  body: string | null;
  url: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string };
  headRef: string;
  headSha: string;
  baseRef: string;
  repoFullName: string;
  repoCloneUrl: string;
}

export interface RepoIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string };
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string; avatarUrl: string }>;
}

export const repoKeys = {
  all: ['repos'] as const,
  list: (page?: number) => [...repoKeys.all, 'list', page] as const,
  validate: (url: string) => [...repoKeys.all, 'validate', url] as const,
  pulls: (owner: string, repo: string) => [...repoKeys.all, 'pulls', owner, repo] as const,
  issues: (owner: string, repo: string) => [...repoKeys.all, 'issues', owner, repo] as const,
};

export function useRepos(page = 1) {
  return useQuery({
    queryKey: repoKeys.list(page),
    // TODO: GitHub's per_page max is 100. Users with more installable repos
    // will need pagination / "load more" — defer beyond v1.
    queryFn: () => api.get<ReposResponse>(`/repos?page=${page}&per_page=100&sort=updated`),
  });
}

export function useValidateRepo(url: string) {
  return useQuery({
    queryKey: repoKeys.validate(url),
    queryFn: () => api.get<ValidateRepoResponse>(`/repos/validate?url=${encodeURIComponent(url)}`),
    enabled: url.length > 0 && url.includes('github.com'),
  });
}

export function useRepoPulls(owner: string, repo: string) {
  return useQuery({
    queryKey: repoKeys.pulls(owner, repo),
    queryFn: () => api.get<{ pulls: RepoPull[] }>(`/repos/${owner}/${repo}/pulls`),
    enabled: !!owner && !!repo,
    select: (data) => data.pulls,
  });
}

export function useRepoIssues(owner: string, repo: string) {
  return useQuery({
    queryKey: repoKeys.issues(owner, repo),
    queryFn: () => api.get<{ issues: RepoIssue[] }>(`/repos/${owner}/${repo}/issues`),
    enabled: !!owner && !!repo,
    select: (data) => data.issues,
  });
}
