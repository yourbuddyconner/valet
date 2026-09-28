// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CreateTeamRequest,
  CreateTeamResponse,
} from "@valet/api/wire";

const createTeam = vi.fn();

vi.mock("./client", () => ({
  api: { createTeam: (body: CreateTeamRequest) => createTeam(body) },
}));

import { qkSettings, teamCreateQueryKeys, useCreateTeam } from "./settings";

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
  runtime: { sessionId: "assistant:asst_team" },
};

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("workspace creation", () => {
  it("invalidates the team list without an assistant-list cache", async () => {
    expect(teamCreateQueryKeys()).toEqual([qkSettings.teams()]);
    createTeam.mockResolvedValueOnce(created);
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCreateTeam(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync({ name: "Platform" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qkSettings.teams() });
    expect(client.getQueryData(["assistants"])).toBeUndefined();
  });
});
