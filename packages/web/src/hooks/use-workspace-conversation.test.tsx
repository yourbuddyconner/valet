// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AssistantSummary } from "@valet/api/wire";
import { useWorkspaceConversation } from "./use-workspace-conversation";

const personal = vi.fn(); const team = vi.fn(); const legacy = vi.fn();
let scope = { key: "user", teamId: undefined as string | undefined };
let search: { assistant?: string; workspace?: string } = {};
let rows: AssistantSummary[] = [];
vi.mock("~/api/client", () => ({ api: {
  ensureOrchestrator: (...args: unknown[]) => personal(...args),
  ensureTeamOrchestrator: (...args: unknown[]) => team(...args),
  ensureAssistantSession: (...args: unknown[]) => legacy(...args),
} }));
vi.mock("~/api/assistants", () => ({ useAssistants: () => ({ data: { assistants: rows }, error: null }) }));
vi.mock("~/lib/workspace-scope", () => ({ useWorkspaceScope: () => scope }));
vi.mock("@tanstack/react-router", () => ({ useSearch: () => search }));
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks(); scope = { key: "user", teamId: undefined }; search = {}; rows = [];
  personal.mockResolvedValue({ sessionId: "personal-session" });
  team.mockResolvedValue({ sessionId: "team-session" });
  legacy.mockResolvedValue({ sessionId: "legacy-session" });
});
describe("workspace conversation", () => {
  it("ensures the personal default without selecting or creating a profile", async () => {
    const { result } = renderHook(() => useWorkspaceConversation(), { wrapper: harness() });
    await waitFor(() => expect(result.current.data?.sessionId).toBe("personal-session"));
    expect(personal).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
  });
  it("switches by owner and never shows the previous workspace while ensuring", async () => {
    const { result, rerender } = renderHook(() => useWorkspaceConversation(), { wrapper: harness() });
    await waitFor(() => expect(result.current.data?.sessionId).toBe("personal-session"));
    scope = { key: "team-a", teamId: "team-a" }; rerender();
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.sessionId).toBe("team-session"));
    expect(team).toHaveBeenCalledWith("team-a");
  });
  it("does not fall back to personal history when team access fails", async () => {
    scope = { key: "team-a", teamId: "team-a" }; team.mockRejectedValue(new Error("not found"));
    const { result } = renderHook(() => useWorkspaceConversation(), { wrapper: harness() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(personal).not.toHaveBeenCalled(); expect(result.current.data).toBeUndefined();
  });
  it("a cold team link targets that team even while the saved scope is personal", async () => {
    search = { workspace: "team-b" }; team.mockRejectedValue(new Error("not found"));
    const { result } = renderHook(() => useWorkspaceConversation(), { wrapper: harness() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(team).toHaveBeenCalledWith("team-b"); expect(personal).not.toHaveBeenCalled();
  });
  it("ignores assistant selection and opens the explicit workspace", async () => {
    search = { assistant: "stale", workspace: "user" };
    const { result } = renderHook(() => useWorkspaceConversation(), { wrapper: harness() });
    await waitFor(() => expect(result.current.data?.sessionId).toBe("personal-session"));
    expect(legacy).not.toHaveBeenCalled();
  });
});
