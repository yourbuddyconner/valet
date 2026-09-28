// @vitest-environment jsdom
/**
 * `useWorkflowAssistant` — the session and thread the editor's right-hand
 * column talks to.
 *
 * The panel shows a stage-naming spinner until BOTH ids are set, so every
 * test here is about one question: does the panel reach that state, and does
 * it say something when it cannot? A hook that resolves neither id and
 * reports no error leaves a spinner on screen forever, which is what a
 * person reported and what these tests hold shut.
 *
 * The whole file runs under `StrictMode`, because `main.tsx` does, and the
 * effects below fire twice there.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type {
  CreateThreadResponse,
  EnsureAssistantSessionResponse,
  GetOrchestratorInfoResponse,
  ListAssistantsResponse,
  SendPromptRequest,
  SendPromptResponse,
} from "@valet/api/wire";
import type { WorkflowDefinition } from "@valet/workflow";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSISTANT_ID = "asst_1";
const SESSION = `assistant:${ASSISTANT_ID}`;
const OTHER_SESSION = "orchestrator:user-1";
const WORKFLOW = "wf_1";

const listAssistants = vi.fn<() => Promise<ListAssistantsResponse>>();
const getOrchestratorInfo = vi.fn<() => Promise<GetOrchestratorInfoResponse>>();
const ensureAssistantSession =
  vi.fn<(assistantId: string) => Promise<EnsureAssistantSessionResponse>>();
const ensureTeamOrchestrator = vi.fn<(teamId: string) => Promise<{ sessionId: string }>>();
const ensureOrchestrator = vi.fn<() => Promise<{ sessionId: string }>>();
const createThread = vi.fn<(sessionId: string) => Promise<CreateThreadResponse>>();
const sendPrompt = vi.fn<(sessionId: string, body: SendPromptRequest) => Promise<SendPromptResponse>>();

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      listAssistants: () => listAssistants(),
      getOrchestratorInfo: () => getOrchestratorInfo(),
      ensureAssistantSession: (assistantId: string) => ensureAssistantSession(assistantId),
      ensureOrchestrator: () => ensureOrchestrator(),
      ensureTeamOrchestrator: (teamId: string) => ensureTeamOrchestrator(teamId),
      createThread: (sessionId: string) => createThread(sessionId),
      sendPrompt: (sessionId: string, body: SendPromptRequest) => sendPrompt(sessionId, body),
    },
  };
});

/** The conversation itself is the chat stack's business — a WS, a
 * transcript and a composer. What matters here is only whether the panel
 * gets far enough to mount it. */
vi.mock("~/components/session/session-view", () => ({
  SessionView: ({ sessionId, activeThreadId }: { sessionId: string; activeThreadId: string }) => (
    <div data-testid="session-view">{`${sessionId} ${activeThreadId}`}</div>
  ),
}));

import { WorkflowAssistantPanel } from "~/components/workflows/editor/assistant-panel";
import { useWorkflowAssistant } from "./use-workflow-assistant";

const DEFINITION: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop", outcome: "success" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

/**
 * One client per TEST, shared by every mount inside it. The app has one
 * client for its whole lifetime, and the remount tests below are about what
 * survives an unmount — a fresh client for each mount would answer a
 * different question.
 */
function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </StrictMode>
  );
}

let wrapper = makeWrapper();

describe("useWorkflowAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    wrapper = makeWrapper();
    listAssistants.mockResolvedValue({
      assistants: [
        {
          id: ASSISTANT_ID,
          owner: { type: "user", id: "user-1" },
          sessionId: SESSION,
          isDefault: true,
          createdAt: 1,
        },
      ],
    });
    getOrchestratorInfo.mockResolvedValue({
      sessionId: SESSION,
      name: null,
      personality: null,
      presence: "idle",
      activeChildren: 0,
    });
    ensureOrchestrator.mockResolvedValue({ sessionId: SESSION });
    ensureOrchestrator.mockResolvedValue({ sessionId: SESSION });
    createThread.mockResolvedValue({ id: "thread_1", sessionId: SESSION, createdAt: 1, lastUserActivityAt: 1 });
    sendPrompt.mockResolvedValue({ messageId: "m1", threadId: "thread_1", activityAt: 1 });
  });

  it("opens the owning team default when the workflow does not pin an assistant", async () => {
    const selected = "assistant:team-selected";
    sessionStorage.setItem(`workflow-assistant:${WORKFLOW}`, JSON.stringify({ sessionId: SESSION, threadId: "personal-thread" }));
    listAssistants.mockResolvedValue({ assistants: [{ id: "team-selected", owner: { type: "team", id: "team-1" }, sessionId: selected, isDefault: true, createdAt: 1 }] });
    ensureTeamOrchestrator.mockResolvedValue({ sessionId: selected });
    const { result } = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "team", ownerId: "team-1" }), { wrapper });
    await waitFor(() => expect(result.current.threadId).toBe("thread_1"));
    expect(result.current.sessionId).toBe(selected);
    expect(ensureTeamOrchestrator).toHaveBeenCalledWith("team-1");
    expect(createThread).toHaveBeenCalledExactlyOnceWith(selected);
    expect(sendPrompt).toHaveBeenCalledExactlyOnceWith(selected, expect.objectContaining({ threadId: "thread_1" }));
    expect(ensureOrchestrator).not.toHaveBeenCalled();
  });

  it("does not fall back to personal when the team workspace is unavailable", async () => {
    ensureTeamOrchestrator.mockRejectedValue(new Error("not found"));
    const { result } = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "team", ownerId: "team-1" }), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.sessionId).toBeUndefined();
    expect(ensureOrchestrator).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it.each(["success", "reject"])("ignores old A thread %s after B is ready", async (outcome) => {
    const workflow = `${WORKFLOW}-${outcome}`;
    listAssistants.mockResolvedValue({ assistants: ["a", "b"].map((id) => ({ id, owner: { type: "team", id: "team-1" }, sessionId: `assistant:${id}`, isDefault: false, createdAt: 1 })) });
    ensureTeamOrchestrator.mockImplementation(async (id) => ({ sessionId: `assistant:${id}` }));
    let finishA: (value: CreateThreadResponse) => void = () => {};
    let failA: (error: Error) => void = () => {};
    createThread.mockImplementation((sessionId) => sessionId === "assistant:a"
      ? new Promise((resolve, reject) => { finishA = resolve; failA = reject; })
      : Promise.resolve({ id: "thread-b", sessionId, createdAt: 1, lastUserActivityAt: 1 }));
    const { result, rerender } = renderHook(({ ownerId }) => useWorkflowAssistant(workflow, "Deploy", { ownerType: "team", ownerId }), { wrapper, initialProps: { ownerId: "a" } });
    await waitFor(() => expect(createThread).toHaveBeenCalledWith("assistant:a"));
    rerender({ ownerId: "b" });
    await waitFor(() => expect(result.current.threadId).toBe("thread-b"));
    await act(async () => {
      if (outcome === "success") finishA({ id: "thread-a", sessionId: "assistant:a", createdAt: 1, lastUserActivityAt: 1 });
      else failA(new Error("late failure"));
    });
    expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("assistant:b", expect.objectContaining({ threadId: "thread-b" }));
    expect(JSON.parse(sessionStorage.getItem(`workflow-assistant:${workflow}`) ?? "null")).toEqual({ sessionId: "assistant:b", threadId: "thread-b" });
    expect(result.current.sessionId).toBe("assistant:b");
    expect(result.current.threadId).toBe("thread-b");
    expect(result.current.opening).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it("reaches the ready state once the session opens and the thread exists", async () => {
    const { result } = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "user", ownerId: "user-1" }), { wrapper });

    await waitFor(() => expect(result.current.threadId).toBe("thread_1"));
    expect(result.current.sessionId).toBe(SESSION);
    expect(result.current.opening).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("mints one thread when the editor mounts again while the first call is in flight", async () => {
    let settle: (thread: CreateThreadResponse) => void = () => {};
    createThread.mockImplementation(
      () => new Promise<CreateThreadResponse>((resolve) => (settle = resolve)),
    );

    const first = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "user", ownerId: "user-1" }), { wrapper });
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(1));

    // The editor page goes away mid-call and comes back. The second mount
    // has an empty ref and an empty sessionStorage, so nothing it owns can
    // tell it a thread is already on its way.
    first.unmount();
    const second = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "user", ownerId: "user-1" }), { wrapper });
    await waitFor(() => expect(second.result.current.sessionId).toBe(SESSION));
    expect(createThread).toHaveBeenCalledTimes(1);

    // React Query drops the callbacks passed to `mutate` when the observer
    // loses its listeners, so a thread remembered from one of those
    // callbacks would be lost with the first mount.
    settle({ id: "thread_1", sessionId: SESSION, createdAt: 1, lastUserActivityAt: 1 });
    await waitFor(() => expect(second.result.current.threadId).toBe("thread_1"));
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("claims a creation completed while unmounted exactly once on remount", async () => {
    let finish: (value: CreateThreadResponse) => void = () => {};
    createThread.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = renderHook(() => useWorkflowAssistant("wf-remount-complete", "Deploy", { ownerType: "user", ownerId: "user-1" }), { wrapper });
    await waitFor(() => expect(createThread).toHaveBeenCalledTimes(1));
    first.unmount();
    await act(async () => { finish({ id: "thread-remount", sessionId: SESSION, createdAt: 1, lastUserActivityAt: 1 }); });
    expect(sendPrompt).not.toHaveBeenCalled();
    const second = renderHook(() => useWorkflowAssistant("wf-remount-complete", "Deploy", { ownerType: "user", ownerId: "user-1" }), { wrapper });
    await waitFor(() => expect(second.result.current.threadId).toBe("thread-remount"));
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledExactlyOnceWith(SESSION, expect.objectContaining({ threadId: "thread-remount" }));
  });

  it("opens the remembered thread again without a second call", async () => {
    const first = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "user", ownerId: "user-1" }), { wrapper });
    await waitFor(() => expect(first.result.current.threadId).toBe("thread_1"));
    first.unmount();

    const second = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "user", ownerId: "user-1" }), { wrapper });
    await waitFor(() => expect(second.result.current.threadId).toBe("thread_1"));
    expect(createThread).toHaveBeenCalledTimes(1);
  });

  it("reports a workspace ensure failure with a retry action", async () => {
    ensureOrchestrator.mockRejectedValue(new Error("Failed to fetch"));
    getOrchestratorInfo.mockRejectedValue(new Error("Failed to fetch"));

    const { result } = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "user", ownerId: "user-1" }), { wrapper });

    await waitFor(() => expect(result.current.error).toBeDefined());
    // The spinner claims work in progress. Nothing is in flight here and
    // nothing retries, so the panel must not show one.
    expect(result.current.opening).toBe(false);
    expect(result.current.error).toContain("Retry");
    expect(createThread).not.toHaveBeenCalled();
  });

  it("says so when the thread cannot be created", async () => {
    createThread.mockRejectedValue(new Error("500"));

    const { result } = renderHook(() => useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "user", ownerId: "user-1" }), { wrapper });

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.opening).toBe(false);
  });
});

describe("WorkflowAssistantPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    wrapper = makeWrapper();
    listAssistants.mockResolvedValue({
      assistants: [
        {
          id: ASSISTANT_ID,
          owner: { type: "user", id: "user-1" },
          sessionId: SESSION,
          isDefault: true,
          createdAt: 1,
        },
      ],
    });
    getOrchestratorInfo.mockResolvedValue({
      sessionId: SESSION,
      name: null,
      personality: null,
      presence: "idle",
      activeChildren: 0,
    });
    ensureOrchestrator.mockResolvedValue({ sessionId: SESSION });
    createThread.mockResolvedValue({ id: "thread_1", sessionId: SESSION, createdAt: 1, lastUserActivityAt: 1 });
    sendPrompt.mockResolvedValue({ messageId: "m1", threadId: "thread_1", activityAt: 1 });
  });

  it("replaces the opening spinner with the conversation", async () => {
    function Panel() {
      const assistant = useWorkflowAssistant(WORKFLOW, "Deploy", { ownerType: "user", ownerId: "user-1" });
      return (
        <WorkflowAssistantPanel
          assistant={assistant}
          definition={DEFINITION}
          workflowId={WORKFLOW}
        />
      );
    }
    render(<Panel />, { wrapper });

    expect(screen.getByText(/Opening your assistant|Starting the conversation/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("session-view").textContent).toBe(`${SESSION} thread_1`),
    );
    expect(screen.queryByText(/Opening your assistant|Starting the conversation/)).toBeNull();
  });
});
