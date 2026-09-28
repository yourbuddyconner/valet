import { qkTemplates } from "./templates";
/**
 * TanStack Query hooks for the settings shell's data surface (split-settings
 * design, Task 5). Mirrors the factory idiom in `src/api/queries.ts`:
 * query-key factory object, one hook per read, mutations invalidate the
 * keys they affect. `/api/me`, `/api/org`, `/api/org/members`, `/api/models`
 * are the four reads; `/api/me`, `/api/org`, `/api/org/members/:userId` are
 * the three writes Tasks 6–7 wire up to actual controls.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  AddTeamMemberRequest,
  CreateLlmProviderRequest,
  CreateLlmProviderResponse,
  CreateTeamRequest,
  CreateTeamResponse,
  PatchTeamRequest,
  PatchTeamResponse,
  DeleteCredentialResponse,
  GetApprovedModelsResponse,
  GetGithubAppResponse,
  GetModelTiersResponse,
  GetOrgReasoningResponse,
  GetSlackAppResponse,
  JoinSuggestedTeamResponse,
  ListLlmProvidersResponse,
  ListModelsResponse,
  ListSuggestedTeamsResponse,
  ListTeamMembersResponse,
  ListTeamsResponse,
  MeResponse,
  OpenrouterRegistryResponse,
  OrgDirectoryResponse,
  OrgMembersResponse,
  OrgPluginsResponse,
  OrgResponse,
  OrgSettingsResponse,
  PatchLlmProviderRequest,
  PatchLlmProviderResponse,
  PatchMeRequest,
  PatchMeResponse,
  PatchModelTiersRequest,
  PatchOrgMemberRequest,
  PatchOrgMemberResponse,
  PatchOrgPluginRequest,
  PatchOrgPluginResponse,
  PatchOrgReasoningRequest,
  PatchOrgReasoningResponse,
  PatchOrgRequest,
  PatchOrgResponse,
  PatchOrgSettingsRequest,
  PostGithubAppCredentialRequest,
  PostGithubAppManifestRequest,
  PostGithubAppManifestResponse,
  ProbeLlmProviderResponse,
  PutApprovedModelsRequest,
  PutApprovedModelsResponse,
  PutCredentialResponse,
  PutLlmProviderKeyRequest,
  PutLlmProviderKeyResponse,
  SetTeamMemberRoleRequest,
  TestLlmProviderRequest,
  TestLlmProviderResponse,
} from "@valet/api/wire";
import { qk } from "./queries";
import { api } from "./client";
import { qkIntegrations } from "./integrations";
import { qkRepos } from "./repos";

/**
 * Whether a named plugin is enabled for the current caller, read from the org
 * query's `plugins` list (plugin-entitlements design). Returns `undefined`
 * while the org query has not resolved, so a caller can hide a gated surface
 * without flashing it — treat `undefined` as "not yet known", not "off".
 * Returns `false` when the plugin is unknown (not loaded on this deployment).
 */
export function pluginEnabledForCaller(
  org: OrgResponse | undefined,
  name: string,
): boolean | undefined {
  if (!org) return undefined;
  return org.plugins.find((p) => p.name === name)?.enabledForCaller ?? false;
}

// ── Query key factory ────────────────────────────────────────────────────

export const qkSettings = {
  me: () => ["settings", "me"] as const,
  org: () => ["settings", "org"] as const,
  orgMembers: () => ["settings", "org", "members"] as const,
  orgDirectory: () => ["settings", "org", "directory"] as const,
  orgPlugins: () => ["settings", "org", "plugins"] as const,
  models: () => ["settings", "models"] as const,
  llmProviders: () => ["settings", "llmProviders"] as const,
  openrouterRegistry: () => ["settings", "openrouterRegistry"] as const,
  modelTiers: () => ["settings", "modelTiers"] as const,
  approvedModels: () => ["settings", "approvedModels"] as const,
  orgReasoning: () => ["settings", "orgReasoning"] as const,
  teams: () => ["settings", "teams"] as const,
  suggestedTeams: () => ["settings", "teams", "suggestions"] as const,
  teamMembers: (teamId: string) => ["settings", "teams", teamId, "members"] as const,
  githubApp: () => ["settings", "githubApp"] as const,
  /** Prefix of every `slackApp` key — what the mutations invalidate. */
  slackAppAll: () => ["settings", "slackApp"] as const,
  /** One manifest per requested app name; `""` is the server default name. */
  slackApp: (name?: string) => ["settings", "slackApp", name ?? ""] as const,
};

// ── Reads ────────────────────────────────────────────────────────────────

export function useMe(opts?: Partial<UseQueryOptions<MeResponse>>) {
  return useQuery<MeResponse>({
    queryKey: qkSettings.me(),
    queryFn: () => api.getMe(),
    // Viewer identity is static for the app session and its mutations
    // invalidate the key; without this, every fresh mount past the 5s app
    // default (e.g. each chat slide-over open) refetches it. Same
    // reasoning as `useOrg` below.
    staleTime: 60_000,
    ...opts,
  });
}

export function useOrg(opts?: Partial<UseQueryOptions<OrgResponse>>) {
  return useQuery<OrgResponse>({
    queryKey: qkSettings.org(),
    queryFn: () => api.getOrg(),
    // The workspace clause mounts this on every list page, so each route
    // change would otherwise refetch it (app default staleTime is 5s). Org
    // facts change rarely and their mutations invalidate the key — same
    // reasoning as `useModels` below.
    staleTime: 60_000,
    ...opts,
  });
}

export function useOrgMembers(opts?: UseQueryOptions<OrgMembersResponse>) {
  return useQuery<OrgMembersResponse>({
    queryKey: qkSettings.orgMembers(),
    queryFn: () => api.getOrgMembers(),
    ...opts,
  });
}

/** Member-visible display identity of every org member — what the teams
 * page uses for roster names and the add-member picker. Reachable by any
 * org member, unlike `useOrgMembers()` (org-admin roster). */
export function useOrgDirectory(opts?: UseQueryOptions<OrgDirectoryResponse>) {
  return useQuery<OrgDirectoryResponse>({
    queryKey: qkSettings.orgDirectory(),
    queryFn: () => api.getOrgDirectory(),
    // Same reasoning as `useOrg` above: membership changes rarely, nothing
    // here depends on it being fresh, and the app default (5s) would refetch
    // the whole directory on every remount of the Teams page.
    staleTime: 60_000,
    ...opts,
  });
}

/** Gateable plugins with this org's entitlement (plugin-entitlements design).
 * Any member reads it; the admin settings page edits it. The nav item and hub
 * gate on `useOrg().data.plugins` instead — the app already fetches org, so
 * this dedicated read only powers the admin page. */
export function useOrgPlugins(opts?: Partial<UseQueryOptions<OrgPluginsResponse>>) {
  return useQuery<OrgPluginsResponse>({
    queryKey: qkSettings.orgPlugins(),
    queryFn: () => api.getOrgPlugins(),
    staleTime: 60_000,
    ...opts,
  });
}

export function useModels(opts?: UseQueryOptions<ListModelsResponse>) {
  return useQuery<ListModelsResponse>({
    queryKey: qkSettings.models(),
    queryFn: () => api.listModels(),
    // Org-admin-editable catalog (LLM providers, model preferences) — Task 7's
    // mutations already invalidate this key on write, but a short staleTime
    // covers changes made from elsewhere (another tab, another org admin).
    staleTime: 60_000,
    ...opts,
  });
}

export function useLlmProviders(opts?: UseQueryOptions<ListLlmProvidersResponse>) {
  return useQuery<ListLlmProvidersResponse>({
    queryKey: qkSettings.llmProviders(),
    queryFn: () => api.listLlmProviders(),
    ...opts,
  });
}

/** Full pi-ai openrouter registry (server-side, no upstream call) — powers
 * the openrouter card's model-selection picker. Static per deploy, so an
 * infinite staleTime; fetched only when the picker opens (`enabled`). */
export function useOpenrouterRegistry(opts?: { enabled?: boolean }) {
  return useQuery<OpenrouterRegistryResponse>({
    queryKey: qkSettings.openrouterRegistry(),
    queryFn: () => api.openrouterRegistry(),
    staleTime: Infinity,
    enabled: opts?.enabled ?? true,
  });
}

export function useModelTiers(opts?: UseQueryOptions<GetModelTiersResponse>) {
  return useQuery<GetModelTiersResponse>({
    queryKey: qkSettings.modelTiers(),
    queryFn: () => api.getModelTiers(),
    ...opts,
  });
}

export function useApprovedModels(opts?: UseQueryOptions<GetApprovedModelsResponse>) {
  return useQuery<GetApprovedModelsResponse>({
    queryKey: qkSettings.approvedModels(),
    queryFn: () => api.getApprovedModels(),
    ...opts,
  });
}

export function useOrgReasoning(opts?: UseQueryOptions<GetOrgReasoningResponse>) {
  return useQuery<GetOrgReasoningResponse>({
    queryKey: qkSettings.orgReasoning(),
    queryFn: () => api.getOrgReasoning(),
    ...opts,
  });
}

export function useTeams(opts?: Partial<UseQueryOptions<ListTeamsResponse>>) {
  return useQuery<ListTeamsResponse>({
    queryKey: qkSettings.teams(),
    queryFn: () => api.listTeams(),
    // Same rule as `useOrg`: read by the workspace clause on every list
    // page; team mutations already invalidate this key.
    staleTime: 60_000,
    ...opts,
  });
}

export function useSuggestedTeams(opts?: Partial<UseQueryOptions<ListSuggestedTeamsResponse>>) {
  return useQuery<ListSuggestedTeamsResponse>({
    queryKey: qkSettings.suggestedTeams(),
    queryFn: () => api.listSuggestedTeams(),
    ...opts,
  });
}

export function useTeamMembers(teamId: string, opts?: UseQueryOptions<ListTeamMembersResponse>) {
  return useQuery<ListTeamMembersResponse>({
    queryKey: qkSettings.teamMembers(teamId),
    queryFn: () => api.listTeamMembers(teamId),
    ...opts,
  });
}


export function useUploadMyAvatar() {
  const qc = useQueryClient();
  return useMutation<{ avatarUrl: string }, Error, File>({
    mutationFn: (file) => api.uploadMyAvatar(file),
    onSuccess: ({ avatarUrl }) => {
      qc.setQueryData<MeResponse>(qkSettings.me(), (previous) =>
        previous ? { ...previous, avatarUrl } : previous,
      );
      qc.invalidateQueries({ queryKey: qkSettings.me() });
    },
  });
}

export function usePatchMe() {
  const qc = useQueryClient();
  return useMutation<
    PatchMeResponse,
    Error,
    PatchMeRequest,
    { previous: MeResponse | undefined }
  >({
    mutationFn: (body) => api.patchMe(body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: qkSettings.me() });
      const previous = qc.getQueryData<MeResponse>(qkSettings.me());
      if (previous) qc.setQueryData<MeResponse>(qkSettings.me(), { ...previous, ...body });
      return { previous };
    },
    onError: (_error, _body, context) => {
      if (context?.previous) qc.setQueryData(qkSettings.me(), context.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qkSettings.me() });
    },
  });
}

export function usePatchOrg() {
  const qc = useQueryClient();
  return useMutation<PatchOrgResponse, Error, PatchOrgRequest>({
    mutationFn: (body) => api.patchOrg(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.org() });
    },
  });
}

/** Org-level toggles (`PATCH /api/org/settings`) — invalidates the org
 * read, which is where `allowPublicArtifacts` is surfaced to members. */
export function usePatchOrgSettings() {
  const qc = useQueryClient();
  return useMutation<OrgSettingsResponse, Error, PatchOrgSettingsRequest>({
    mutationFn: (body) => api.patchOrgSettings(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.org() });
    },
  });
}

/** Sets one plugin's entitlement (`PATCH /api/org/plugins/:name`) — org admin
 * only. Invalidates BOTH the dedicated plugins read (the admin page) AND the
 * org read (the nav item + hub gate on `useOrg().data.plugins`), so a mode
 * change refreshes visibility everywhere. */
export function usePatchOrgPlugin() {
  const qc = useQueryClient();
  return useMutation<
    PatchOrgPluginResponse,
    Error,
    { name: string; body: PatchOrgPluginRequest }
  >({
    mutationFn: ({ name, body }) => api.patchOrgPlugin(name, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.orgPlugins() });
      qc.invalidateQueries({ queryKey: qkSettings.org() });
    },
  });
}

export function useSetOrgMemberRole() {
  const qc = useQueryClient();
  return useMutation<
    PatchOrgMemberResponse,
    Error,
    { userId: string; body: PatchOrgMemberRequest },
    { previous: OrgMembersResponse | undefined }
  >({
    mutationFn: ({ userId, body }) => api.patchOrgMember(userId, body),
    // Optimistic: the row flips immediately, then rolls back if the server
    // rejects it (e.g. the last-admin guard) — the UI disable on the sole
    // admin row is a courtesy, not the source of truth.
    onMutate: async ({ userId, body }) => {
      await qc.cancelQueries({ queryKey: qkSettings.orgMembers() });
      const previous = qc.getQueryData<OrgMembersResponse>(qkSettings.orgMembers());
      if (previous) {
        qc.setQueryData<OrgMembersResponse>(qkSettings.orgMembers(), {
          members: previous.members.map((m) =>
            m.userId === userId ? { ...m, role: body.role } : m,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(qkSettings.orgMembers(), context.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qkSettings.orgMembers() });
    },
  });
}

// ── LLM providers ────────────────────────────────────────────────────────

export function useCreateLlmProvider() {
  const qc = useQueryClient();
  return useMutation<CreateLlmProviderResponse, Error, CreateLlmProviderRequest>({
    mutationFn: (body) => api.createLlmProvider(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function usePatchLlmProvider() {
  const qc = useQueryClient();
  return useMutation<PatchLlmProviderResponse, Error, { id: string; body: PatchLlmProviderRequest }>({
    mutationFn: ({ id, body }) => api.patchLlmProvider(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function useDeleteLlmProvider() {
  const qc = useQueryClient();
  return useMutation<undefined, Error, string>({
    mutationFn: (id) => api.deleteLlmProvider(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function usePutLlmProviderKey() {
  const qc = useQueryClient();
  return useMutation<PutLlmProviderKeyResponse, Error, { id: string; body: PutLlmProviderKeyRequest }>({
    mutationFn: ({ id, body }) => api.putLlmProviderKey(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function useDeleteLlmProviderKey() {
  const qc = useQueryClient();
  return useMutation<undefined, Error, string>({
    mutationFn: (id) => api.deleteLlmProviderKey(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.llmProviders() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function useProbeLlmProvider() {
  return useMutation<ProbeLlmProviderResponse, Error, string>({
    mutationFn: (id) => api.probeLlmProvider(id),
  });
}

export function useTestLlmProvider() {
  return useMutation<TestLlmProviderResponse, Error, { id: string; body: TestLlmProviderRequest }>({
    mutationFn: ({ id, body }) => api.testLlmProvider(id, body),
  });
}

export function usePatchModelTiers() {
  const qc = useQueryClient();
  return useMutation<GetModelTiersResponse, Error, PatchModelTiersRequest>({
    mutationFn: (body) => api.patchModelTiers(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.modelTiers() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function usePutApprovedModels() {
  const qc = useQueryClient();
  return useMutation<PutApprovedModelsResponse, Error, PutApprovedModelsRequest>({
    mutationFn: (body) => api.putApprovedModels(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.approvedModels() });
      qc.invalidateQueries({ queryKey: qkSettings.models() });
    },
  });
}

export function usePatchOrgReasoning() {
  const qc = useQueryClient();
  return useMutation<PatchOrgReasoningResponse, Error, PatchOrgReasoningRequest>({
    mutationFn: (body) => api.patchOrgReasoning(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.orgReasoning() });
    },
  });
}

// ── Teams ────────────────────────────────────────────────────────────────

/**
 * Keys `useCreateTeam` invalidates. `createTeam` writes the team's default
 * assistant in the same transaction, so the assistants prefix must refresh
 * or `/chat` treats the new team as empty until the next list fetch.
 */
export function teamCreateQueryKeys() {
  return [qkSettings.teams()] as const;
}

export function useJoinSuggestedTeam() {
  const qc = useQueryClient();
  return useMutation<JoinSuggestedTeamResponse, Error, string>({
    mutationFn: (teamId) => api.joinSuggestedTeam(teamId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.suggestedTeams() });
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation<CreateTeamResponse, Error, CreateTeamRequest>({
    mutationFn: (body) => api.createTeam(body),
    onSuccess: (created) => {
      for (const queryKey of teamCreateQueryKeys()) {
        qc.invalidateQueries({ queryKey });
      }
    },
  });
}

export function usePatchTeam() {
  const qc = useQueryClient();
  return useMutation<
    PatchTeamResponse,
    Error,
    { id: string; body: PatchTeamRequest },
    { previous: ListTeamsResponse | undefined }
  >({
    mutationFn: ({ id, body }) => api.patchTeam(id, body),
    // Optimistic, like useSetOrgMemberRole: the combobox/select read the
    // teams cache, so without this the control shows the OLD value for the
    // whole PATCH round trip and a save looks like it did not take.
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: qkSettings.teams() });
      const previous = qc.getQueryData<ListTeamsResponse>(qkSettings.teams());
      if (previous && (body.defaultModel !== undefined || body.defaultReasoning !== undefined)) {
        qc.setQueryData<ListTeamsResponse>(qkSettings.teams(), {
          teams: previous.teams.map((t) =>
            t.id === id
              ? {
                  ...t,
                  ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
                  ...(body.defaultReasoning !== undefined
                    ? { defaultReasoning: body.defaultReasoning }
                    : {}),
                }
              : t,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(qkSettings.teams(), context.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteTeam(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}


export function useAddTeamMember() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { teamId: string; body: AddTeamMemberRequest }>({
    mutationFn: ({ teamId, body }) => api.addTeamMember(teamId, body),
    onSuccess: (_data, { teamId }) => {
      qc.invalidateQueries({ queryKey: qkSettings.teamMembers(teamId) });
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

export function useSetTeamMemberRole() {
  const qc = useQueryClient();
  return useMutation<
    { ok: true },
    Error,
    { teamId: string; userId: string; body: SetTeamMemberRoleRequest }
  >({
    mutationFn: ({ teamId, userId, body }) => api.setTeamMemberRole(teamId, userId, body),
    onSuccess: (_data, { teamId }) => {
      qc.invalidateQueries({ queryKey: qkSettings.teamMembers(teamId) });
    },
  });
}

export function useRemoveTeamMember() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { teamId: string; userId: string }>({
    mutationFn: ({ teamId, userId }) => api.removeTeamMember(teamId, userId),
    onSuccess: (_data, { teamId }) => {
      qc.invalidateQueries({ queryKey: qkSettings.teamMembers(teamId) });
      qc.invalidateQueries({ queryKey: qkSettings.teams() });
    },
  });
}

// ── GitHub App (GitHub/repo integration plan, Task 5/11) — org-admin-only ──

export function useGithubApp(opts?: UseQueryOptions<GetGithubAppResponse>) {
  return useQuery<GetGithubAppResponse>({
    queryKey: qkSettings.githubApp(),
    queryFn: () => api.getGithubApp(),
    ...opts,
  });
}

export function useCreateGithubAppManifest() {
  return useMutation<PostGithubAppManifestResponse, Error, PostGithubAppManifestRequest | void>({
    mutationFn: (body) => api.postGithubAppManifest(body ?? {}),
    // No invalidation — nothing changes until the admin completes the
    // browser-POST manifest flow and GitHub redirects back to `GET /setup`.
  });
}

/** Connects a GitHub App that already exists. The server checks the
 * credential with GitHub before it stores anything, so a rejection here means
 * the credential is wrong, not that the save failed. */
export function useSaveGithubAppCredential() {
  const qc = useQueryClient();
  return useMutation<GetGithubAppResponse, Error, PostGithubAppCredentialRequest>({
    mutationFn: (body) => api.postGithubAppCredential(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.githubApp() });
      qc.invalidateQueries({ queryKey: qkRepos.githubOrgStatus() });
      qc.invalidateQueries({ queryKey: qkTemplates.all() });
    },
  });
}

export function useRefreshGithubApp() {
  const qc = useQueryClient();
  return useMutation<GetGithubAppResponse, Error, void>({
    mutationFn: () => api.refreshGithubApp(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.githubApp() });
      qc.invalidateQueries({ queryKey: qkRepos.githubOrgStatus() });
      qc.invalidateQueries({ queryKey: qkTemplates.all() });
    },
  });
}

export function useDeleteGithubApp() {
  const qc = useQueryClient();
  return useMutation<undefined, Error, void>({
    mutationFn: () => api.deleteGithubApp(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.githubApp() });
      qc.invalidateQueries({ queryKey: qkRepos.githubOrgStatus() });
      qc.invalidateQueries({ queryKey: qkTemplates.all() });
    },
  });
}

// ── Slack app (agent surface) — org-admin-only ─────────────────────────────

export function useSlackApp(name?: string, opts?: Partial<UseQueryOptions<GetSlackAppResponse>>) {
  return useQuery<GetSlackAppResponse>({
    queryKey: qkSettings.slackApp(name),
    queryFn: () => api.getSlackApp(name),
    ...opts,
  });
}

/** Saves the org Slack credential. The server checks the bot token with
 * Slack (`auth.test` + required scopes) before it stores anything, so a
 * rejection here means the token or secret is wrong, not that the save
 * failed. `appToken` is the app-level `xapp-` token Socket Mode ingress
 * polls with (`plugin-slack`'s `socketModePoll`); a webhook deployment has
 * no use for it. */
export function useSaveSlackCredential() {
  const qc = useQueryClient();
  return useMutation<
    PutCredentialResponse,
    Error,
    { accessToken: string; webhookSecret: string; appToken?: string }
  >({
    mutationFn: ({ accessToken, webhookSecret, appToken }) =>
      api.putCredential("slack", {
        type: "bot_token",
        accessToken,
        scope: "org",
        metadata: { webhookSecret, ...(appToken ? { appToken } : {}) },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.slackAppAll() });
      qc.invalidateQueries({ queryKey: qkIntegrations.pluginsAll() });
    },
  });
}

export function useDeleteSlackApp() {
  const qc = useQueryClient();
  return useMutation<DeleteCredentialResponse, Error, void>({
    mutationFn: () => api.deleteCredential("slack", { scope: "org" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.slackAppAll() });
      qc.invalidateQueries({ queryKey: qkIntegrations.pluginsAll() });
    },
  });
}
