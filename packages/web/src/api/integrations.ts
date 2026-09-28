/**
 * Plugins + credentials queries (plugin-system-v2 plan Task 15 — connect
 * surface, manual token entry only). House pattern: a query-key factory per
 * resource file, mirroring `~/api/workflows` / `~/api/workspace-runtime`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  DeleteCredentialResponse,
  DelegateCredentialRequest,
  DelegateCredentialResponse,
  ListCredentialsResponse,
  ListPluginsResponse,
  PutCredentialRequest,
  PutCredentialResponse,
} from "@valet/api/wire";
import { api } from "./client";
import { onePasswordKeys } from "./onepassword";

export type CredentialScope = "user" | "org" | "team";

export const qkIntegrations = {
  /** Prefix for every personal and team plugin catalog. */
  pluginsAll: () => ["plugins"] as const,
  plugins: (teamId?: string) => ["plugins", teamId ?? ""] as const,
  /** `scope` defaults to "user" — the caller's own credentials. "org"
   * (admin-only server-side) is a distinct cache entry, not a filter over
   * the same list. `/integrations` reads both when the caller is an admin.
   * "team" pins one team; `teamId` is part of the key. */
  credentials: (scope: CredentialScope = "user", teamId?: string) =>
    ["credentials", scope, teamId ?? ""] as const,
};

export function usePlugins(teamId?: string, opts?: Partial<UseQueryOptions<ListPluginsResponse>>) {
  return useQuery<ListPluginsResponse>({
    queryKey: qkIntegrations.plugins(teamId),
    queryFn: () => api.listPlugins(teamId),
    ...opts,
  });
}

export function useCredentials(
  scope: CredentialScope = "user",
  opts?: Partial<UseQueryOptions<ListCredentialsResponse>> & { teamId?: string },
) {
  const { teamId, ...queryOpts } = opts ?? {};
  return useQuery<ListCredentialsResponse>({
    queryKey: qkIntegrations.credentials(scope, teamId),
    queryFn: () => api.listCredentials(scope, teamId),
    enabled: scope !== "team" || Boolean(teamId),
    ...queryOpts,
  });
}

/** Connect (or reconnect) a service. Invalidates both the plugin list
 * (connected flags) and both credential-scope caches after a successful
 * save — the response doesn't echo the resolved owner scope, so the exact
 * key affected isn't knowable here without re-deriving it from `body.scope`. */
export function useConnectCredential() {
  const qc = useQueryClient();
  return useMutation<PutCredentialResponse, Error, { service: string; body: PutCredentialRequest }>({
    mutationFn: ({ service, body }) => api.putCredential(service, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkIntegrations.pluginsAll() });
      qc.invalidateQueries({ queryKey: ["credentials"] });
      // The 1Password panel's Connected state reads its own settings query.
      qc.invalidateQueries({ queryKey: onePasswordKeys.settings() });
    },
  });
}

export function useDisconnectCredential() {
  const qc = useQueryClient();
  return useMutation<
    DeleteCredentialResponse,
    Error,
    { service: string; scope?: CredentialScope; teamId?: string }
  >({
    mutationFn: ({ service, scope, teamId }) =>
      api.deleteCredential(service, scope ? { scope, teamId } : undefined),
    onSuccess: (_data, { scope, teamId }) => {
      if (scope === "team") {
        // The completed request owns these invalidations, even after a
        // workspace switch. The team catalog includes direct credentials.
        qc.invalidateQueries({ queryKey: qkIntegrations.credentials("team", teamId) });
        qc.invalidateQueries({ queryKey: qkIntegrations.plugins(teamId) });
        return;
      }
      qc.invalidateQueries({ queryKey: qkIntegrations.pluginsAll() });
      qc.invalidateQueries({ queryKey: ["credentials"] });
      qc.invalidateQueries({ queryKey: onePasswordKeys.settings() });
    },
  });
}

function invalidateCredentialCaches(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: qkIntegrations.pluginsAll() });
  qc.invalidateQueries({ queryKey: ["credentials"] });
}

export function useDelegateCredential() {
  const qc = useQueryClient();
  return useMutation<
    DelegateCredentialResponse,
    Error,
    { service: string; body: DelegateCredentialRequest }
  >({
    mutationFn: ({ service, body }) => api.delegateCredential(service, body),
    onSuccess: () => invalidateCredentialCaches(qc),
  });
}

export function useRevokeDelegation() {
  const qc = useQueryClient();
  return useMutation<DeleteCredentialResponse, Error, { service: string; teamId: string }>({
    mutationFn: ({ service, teamId }) => api.revokeDelegation(service, teamId),
    onSuccess: () => invalidateCredentialCaches(qc),
  });
}
