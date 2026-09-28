/**
 * Assistants: the rows a principal owns, and the writes that create, rename
 * and archive them (`docs/specs/2026-08-13-assistants-design.md`).
 *
 * House pattern: a query-key factory per resource file, mirroring
 * `~/api/queries`. Every write invalidates the one list key, because the
 * list is what the whole client reads — the rail, the chat route and the
 * session header all resolve an assistant from it.
 */
import {
  useQuery,
  type UseQueryOptions
} from "@tanstack/react-query";
import type {
  AssistantSummary,
  ListAssistantsResponse
} from "@valet/api/wire";
import { assistantLabel, orchestratorName } from "~/lib/assistant-name";
import type { OwnerFilter } from "./client";
import { api } from "./client";
import { useOrchestratorInfo } from "./orchestrator";
import { qk } from "./queries";

export const qkAssistants = {
  // Derived from the central factory: useDeleteSession invalidates the same
  // key, and two spellings of it would drift apart.
  list: () => qk.assistants(),
  /** One assistant's ensured session. Its own root, not under `list()`: a
   * list invalidation must not re-run the ensure. */
  session: (assistantId: string) => ["assistant-session", assistantId] as const,
};

export function useAssistants(opts?: Partial<UseQueryOptions<ListAssistantsResponse>>) {
  return useQuery<ListAssistantsResponse>({
    queryKey: qkAssistants.list(),
    queryFn: () => api.listAssistants(),
    ...opts,
  });
}

/**
 * The assistant a principal's machine-driven paths target, and the one a
 * link means when it says "open this team's assistant" — a caller that knows
 * only an owner has no basis for choosing between several, which is the same
 * problem workflow nodes and channel bindings resolve this way.
 *
 * Undefined when the list has not arrived, or when the owner has no
 * assistant the caller may open. A caller must not link at all in that case:
 * there is no id to link to.
 */
export function defaultAssistantFor(
  assistants: AssistantSummary[] | undefined,
  ownerType: "user" | "team" | "org",
  ownerId: string,
): AssistantSummary | undefined {
  const owned = (assistants ?? []).filter(
    (a) => a.owner.type === ownerType && a.owner.id === ownerId,
  );
  return owned.find((a) => a.isDefault) ?? owned[0];
}

/**
 * The display name of the assistant that owns a workspace's memory and
 * threads, for hint copy like "Talk to {name}". A team scope names the team's
 * default assistant; personal scope keeps the caller's own assistant name
 * (from orchestrator info, which answers before the assistants list on a cold
 * load). Falls back to a generic phrase so the copy is never blank or wrong.
 */
export function useScopedAssistantName(owner?: OwnerFilter): string {
  const info = useOrchestratorInfo();
  const isTeam = owner?.ownerType === "team";
  // Only a team scope needs the list; personal reads from `info`.
  const assistantsQ = useAssistants({ enabled: isTeam });
  if (isTeam) {
    const teamAssistant = defaultAssistantFor(assistantsQ.data?.assistants, "team", owner.ownerId);
    return teamAssistant ? assistantLabel(teamAssistant) : orchestratorName(undefined);
  }
  return orchestratorName(info.data?.name);
}
