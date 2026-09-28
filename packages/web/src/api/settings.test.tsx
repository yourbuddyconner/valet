// @vitest-environment jsdom
/**
 * `useCreateTeam` — what the team create writes into the assistants cache.
 *
 * `createTeam` seeds the team's default assistant in the same transaction,
 * and the hook writes that row into the list cache before the refetch so
 * `/chat` opens it at once. The write applies only to a WARM cache. A cold
 * one is left cold and the invalidation fetches the real list: a one-row
 * list seeded here would satisfy every "list resolved" gate on the page
 * with the caller's own assistants missing until the refetch landed.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AssistantSummary,
  CreateTeamRequest,
  CreateTeamResponse,
  ListAssistantsResponse,
} from "@valet/api/wire";

const createTeam = vi.fn();

vi.mock("./client", () => ({
  api: { createTeam: (body: CreateTeamRequest) => createTeam(body) },
}));

import { qk } from "./queries";
import { qkSettings, teamCreateQueryKeys, useCreateTeam } from "./settings";

function assistant(id: string, owner: AssistantSummary["owner"]): AssistantSummary {
  return { id, owner, sessionId: `assistant:${id}`, createdAt: 1 };
}

const created: CreateTeamResponse = {
  team: {
    id: "team_1",
    orgId: "org_1",
    name: "Platform",
    origin: "local",
    externalId: null,
    createdAt: 1,
    memberCount: 1,
    callerRole: "admin",
    defaultModel: null,
  },
  defaultAssistant: assistant("asst_team", { type: "team", id: "team_1" }),
};

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("teamCreateQueryKeys", () => {
  it("invalidates teams and the bare assistants prefix", () => {
    // `createTeam` writes the team's default assistant in the same
    // transaction. The assistants key is the prefix (`["assistants"]`) so
    // every workspace's cache entry refreshes, same convention as
    // `qk.sessions()`.
    expect(teamCreateQueryKeys()).toEqual([qkSettings.teams(), qk.assistants()]);
    expect(qk.assistants()).toEqual(["assistants"]);
  });
});

describe("useCreateTeam", () => {
  it("appends the seeded assistant to a warm list cache", async () => {
    createTeam.mockResolvedValueOnce(created);
    const client = makeClient();
    const mine = assistant("asst_own", { type: "user", id: "u1" });
    client.setQueryData<ListAssistantsResponse>(qk.assistants(), { assistants: [mine] });

    const { result } = renderHook(() => useCreateTeam(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync({ name: "Platform" });

    await waitFor(() =>
      expect(client.getQueryData<ListAssistantsResponse>(qk.assistants())).toEqual({
        assistants: [mine, created.defaultAssistant],
      }),
    );
  });

  it("leaves a cold list cache cold and relies on the invalidation", async () => {
    // Nothing has fetched the list yet. Seeding `{assistants: [row]}` here
    // would stand in for the whole list until the refetch: the personal
    // group vanishes from the rail and `/chat` treats the one-row list as
    // resolved.
    createTeam.mockResolvedValueOnce(created);
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useCreateTeam(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync({ name: "Platform" });

    expect(client.getQueryData(qk.assistants())).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.assistants() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qkSettings.teams() });
  });
});
