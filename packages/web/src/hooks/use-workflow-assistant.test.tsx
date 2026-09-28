// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowAssistant } from "./use-workflow-assistant";

const { ensure } = vi.hoisted(() => ({ ensure: vi.fn<(id: string) => Promise<{ sessionId: string; threadId: string }>>() }));
vi.mock("~/api/client", () => ({ api: { ensureWorkflowConversation: ensure } }));
function wrapper({ children }: { children: ReactNode }) {
  return <StrictMode><QueryClientProvider client={client}>{children}</QueryClientProvider></StrictMode>;
}
let client: QueryClient;
const routing = { ownerType: "user", ownerId: "user-1" };
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  ensure.mockReset().mockImplementation(async id => ({ sessionId: "session", threadId: `thread:${id}` }));
});
describe("workflow editor conversation", () => {
  it("opens through the server without browser storage or an automatic prompt", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useWorkflowAssistant("a", "A", routing), { wrapper });
    expect(result.current.opening).toBe(true);
    await waitFor(() => expect(result.current.threadId).toBe("thread:a"));
    expect(result.current.sessionId).toBe("session");
    expect(ensure).toHaveBeenCalledExactlyOnceWith("a");
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });
  it("revalidates on remount and returns the server's stable identifiers", async () => {
    const first = renderHook(() => useWorkflowAssistant("a", "A", routing), { wrapper });
    await waitFor(() => expect(first.result.current.threadId).toBe("thread:a"));
    first.unmount();
    const second = renderHook(() => useWorkflowAssistant("a", "A", routing), { wrapper });
    await waitFor(() => expect(second.result.current.threadId).toBe("thread:a"));
    expect(ensure).toHaveBeenCalledTimes(2);
  });
  it("isolates navigation from a late response for another workflow", async () => {
    let finish: (value: { sessionId: string; threadId: string }) => void = () => {};
    ensure.mockImplementation(id => id === "a" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ sessionId: "b", threadId: "thread:b" }));
    const { result, rerender } = renderHook(({ id }) => useWorkflowAssistant(id, id, routing), { wrapper, initialProps: { id: "a" } });
    rerender({ id: "b" });
    expect(result.current.threadId).toBeUndefined();
    await waitFor(() => expect(result.current.threadId).toBe("thread:b"));
    await act(async () => { finish({ sessionId: "a", threadId: "thread:a" }); });
    expect(result.current.sessionId).toBe("b");
    expect(result.current.threadId).toBe("thread:b");
  });
  it("shows a corrective error and retries the failed server request", async () => {
    ensure.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useWorkflowAssistant("a", "A", routing), { wrapper });
    await waitFor(() => expect(result.current.error).toContain("Retry"));
    expect(result.current.opening).toBe(false);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.threadId).toBe("thread:a"));
    expect(result.current.error).toBeUndefined();
  });
  it("hides previously cached identifiers when access is revoked", async () => {
    const first = renderHook(() => useWorkflowAssistant("a", "A", routing), { wrapper });
    await waitFor(() => expect(first.result.current.threadId).toBe("thread:a"));
    first.unmount();
    ensure.mockRejectedValue(new Error("404"));
    const second = renderHook(() => useWorkflowAssistant("a", "A", routing), { wrapper });
    await waitFor(() => expect(second.result.current.error).toContain("Retry"));
    expect(second.result.current.threadId).toBeUndefined();
    expect(second.result.current.sessionId).toBeUndefined();
  });
});
