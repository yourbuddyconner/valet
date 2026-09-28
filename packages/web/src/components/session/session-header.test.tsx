// @vitest-environment jsdom
/**
 * Sandbox hibernation plan, Task 5: the pause control + sleeping badge.
 * `SandboxChip` gains a `suspended` entry (dot + "sleeping — will wake on
 * message" tooltip label), and the header grows a pause button that posts
 * `usePauseSession`, is disabled unless `sandbox.state === "ready"`, and
 * surfaces the mutation's error text verbatim on failure (e.g. the 409
 * "a turn is running" / "sandbox is not ready to pause" bodies).
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ListTeamsResponse, SessionDetail } from "@valet/api/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "~/components/primitives";
import { useStreamStore } from "~/stores/stream";

const deleteMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const rateSessionMutate = vi.fn();
const setModelMutate = vi.fn();
const setThreadModelMutate = vi.fn();
const setReasoningMutate = vi.fn();
const setThreadReasoningMutate = vi.fn();
/** Threads for the header's thread-scoped model picker. Empty by default:
 * the picker then falls back to the session default (legacy behavior). */
let headerThreads: Array<{
  id: string;
  sessionId: string;
  createdAt: number;
  model?: string;
  reasoning?: string | null;
}> = [];
let sessionRating: "positive" | "negative" | null = null;
let ratingPending = false;
let pauseMutateAsync = vi.fn().mockResolvedValue({ status: "hibernated" });
let pauseIsPending = false;
let replaceMutateAsync = vi.fn().mockResolvedValue({ ok: true });
let renameMutateAsync = vi.fn().mockResolvedValue({ ok: true });
let setProfileMutateAsync = vi.fn().mockResolvedValue({ ok: true });
/** The header resolves a team assistant's title and its admin controls from
 * these two lists: the assistant says who owns the session, the team says
 * what that owner is called and what the caller may do. Empty-but-RESOLVED
 * by default so the pause/delete cases below exercise a plain personal
 * session: the delete item fails closed until both the assistants list and
 * the orchestrator probe have data (TKAI-253). Set either to `undefined`
 * to model its query still in flight. */
let teamsData: ListTeamsResponse = { teams: [] };
let isWorkspaceRuntime: boolean | undefined = false;
/** The viewer's own orchestrator probe — the header matches its sessionId
 * against `session.id`. Defaults to a non-matching id so ordinary sessions
 * read as ordinary. */

// importOriginal, not a bare replacement: vitest.config.ts sets
// `isolate: false` to share the module registry across test files in a
// worker (perf — avoids re-importing React/Radix/xyflow per file). Under
// that setting an incomplete `vi.mock("~/api/queries", ...)` in ANY file
// can end up governing the module for OTHER files sharing the worker —
// spreading the real module keeps every export present no matter whose
// factory the shared registry ends up using.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useDeleteSession: () => ({ isPending: false, mutateAsync: deleteMutateAsync }),
    useSetSessionModel: () => ({ isPending: false, mutate: setModelMutate }),
    useSetThreadModel: () => ({ isPending: false, mutate: setThreadModelMutate }),
    useSetSessionReasoning: () => ({ isPending: false, mutate: setReasoningMutate }),
    useSetThreadReasoning: () => ({ isPending: false, mutate: setThreadReasoningMutate }),
    useThreads: () => ({ data: { threads: headerThreads }, isLoading: false, error: null }),
    usePauseSession: () => ({ isPending: pauseIsPending, mutateAsync: pauseMutateAsync }),
    useReplaceSandbox: () => ({ isPending: false, mutateAsync: replaceMutateAsync }),
    useRenameSession: () => ({ isPending: false, mutateAsync: renameMutateAsync }),
    useSetSessionProfile: () => ({ isPending: false, mutateAsync: setProfileMutateAsync }),
    useSessionRatings: () => ({ data: { session: sessionRating, entries: {} }, isLoading: false, error: null }),
    useRateSession: () => ({ isPending: ratingPending, mutate: rateSessionMutate }),
  };
});

vi.mock("~/api/settings", () => ({
  useModels: () => ({ data: { models: [] }, isLoading: false, error: null }),
  useMe: () => ({ data: undefined, isLoading: false, error: null }),
  useOrg: () => ({ data: undefined, isLoading: false, error: null }),
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useModelTiers: () => ({ data: undefined, isLoading: false, error: null }),
  useApprovedModels: () => ({ data: { approved: null }, isLoading: false, error: null }),
  useOrgReasoning: () => ({ data: undefined, isLoading: false, error: null }),
}));


vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

import { SandboxChip, SessionHeader } from "./session-header";

function baseSession(): SessionDetail {
  return {
    id: "sess-1",
    isWorkspaceRuntime,
    workspace: "acme/repo",
    status: "active",
    kind: "code",
    runState: "idle",
    owner: { type: "user", id: "u1" },
    title: "Fix the bug",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    messageCount: 3,
    profile: "headless",
    docker: false,
  };
}

function renderHeader(
  sandbox?: { state: string; epoch: number },
  threadId?: string,
  session = baseSession(),
) {
  return render(headerElement(sandbox, threadId, session));
}

function headerElement(
  sandbox?: { state: string; epoch: number },
  threadId?: string,
  session = baseSession(),
) {
  return (
    <TooltipProvider>
      <SessionHeader
        session={session}
        agentStatus="idle"
        conn="open"
        sandbox={sandbox}
        threadId={threadId}
      />
    </TooltipProvider>
  );
}

function activeModel(threadId: string, model: string) {
  useStreamStore.getState().ingest("sess-1", {
    seq: 1,
    ts: Date.now(),
    type: "model.state",
    threadId,
    queueItemId: `queue-${threadId}`,
    model,
  });
}

function idleModel(threadId: string) {
  useStreamStore.getState().ingest("sess-1", {
    seq: 2,
    ts: Date.now(),
    type: "model.state",
    threadId,
    queueItemId: null,
    model: null,
  });
}

beforeEach(() => {
  useStreamStore.setState({ bySession: {} });
  deleteMutateAsync.mockClear();
  rateSessionMutate.mockClear();
  sessionRating = null;
  ratingPending = false;
  setModelMutate.mockClear();
  setThreadModelMutate.mockClear();
  setReasoningMutate.mockClear();
  setThreadReasoningMutate.mockClear();
  headerThreads = [];
  pauseMutateAsync = vi.fn().mockResolvedValue({ status: "hibernated" });
  pauseIsPending = false;
  replaceMutateAsync = vi.fn().mockResolvedValue({ ok: true });
  renameMutateAsync = vi.fn().mockResolvedValue({ ok: true });
  setProfileMutateAsync = vi.fn().mockResolvedValue({ ok: true });
  teamsData = { teams: [] };
  isWorkspaceRuntime = false;
});

describe("SandboxChip — suspended state", () => {
  it("renders the sleeping label for a suspended sandbox", () => {
    render(
      <TooltipProvider>
        <SandboxChip sandbox={{ state: "suspended", epoch: 1 }} />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText("sleeping — will wake on message")).toBeTruthy();
  });
});

describe("SessionHeader — thread-scoped model picker", () => {
  it("shows the selected thread's active submission model", () => {
    headerThreads = [
      { id: "th-1", sessionId: "sess-1", createdAt: 1, model: "claude-sonnet-4-5" },
    ];
    activeModel("th-1", "anthropic/claude-opus-4-7");

    renderHeader(undefined, "th-1");

    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain(
      "Opus 4.7",
    );
  });

  it("follows active submission models when the selected thread changes", () => {
    headerThreads = [
      { id: "th-1", sessionId: "sess-1", createdAt: 1, model: "l" },
      { id: "th-2", sessionId: "sess-1", createdAt: 2, model: "l" },
    ];
    activeModel("th-1", "anthropic/claude-opus-4-7");
    activeModel("th-2", "anthropic/claude-haiku-4-5");
    const { rerender } = renderHeader(undefined, "th-1");
    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain(
      "Opus 4.7",
    );

    rerender(headerElement(undefined, "th-2"));

    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain(
      "Haiku 4.5",
    );
  });

  it("falls back to the configured model when model.state becomes idle", () => {
    headerThreads = [
      { id: "th-1", sessionId: "sess-1", createdAt: 1, model: "claude-sonnet-4-5" },
    ];
    activeModel("th-1", "anthropic/claude-opus-4-7");
    renderHeader(undefined, "th-1");
    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain(
      "Opus 4.7",
    );

    act(() => idleModel("th-1"));

    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain(
      "Sonnet 4.5",
    );
  });

  it("announces different runtime and configured models on the picker button", () => {
    headerThreads = [{ id: "th-1", sessionId: "sess-1", createdAt: 1, model: "l" }];
    activeModel("th-1", "openai/gpt-5.2");
    renderHeader(undefined, "th-1");

    expect(
      screen.getByRole("button", {
        name: "Choose model: openai/gpt-5.2",
        description:
          "Model for this thread (pinned at creation). New threads use the workspace default. Currently using openai/gpt-5.2 for this submission. Configured as l.",
      }),
    ).toBeTruthy();
  });

  it("does not announce a difference for equivalent Anthropic model ids", () => {
    headerThreads = [
      { id: "th-1", sessionId: "sess-1", createdAt: 1, model: "claude-opus-4-7" },
    ];
    activeModel("th-1", "anthropic/claude-opus-4-7");
    renderHeader(undefined, "th-1");

    expect(
      screen.getByRole("button", {
        name: "Choose model: Opus 4.7",
        description:
          "Model for this thread (pinned at creation). New threads use the workspace default.",
      }),
    ).toBeTruthy();
  });

  it("shows the ACTIVE THREAD's pinned model, not the session default", () => {
    headerThreads = [
      { id: "th-1", sessionId: "sess-1", createdAt: 1, model: "claude-opus-4-7" },
    ];
    renderHeader(undefined, "th-1");
    const trigger = screen.getByRole("button", { name: /^Choose model:/ });
    expect(trigger.textContent).toContain("Opus 4.7");
  });

  it("disables the picker while the active thread is unresolved (never a session-scope write)", () => {
    // threadId is set but the threads list has no match (query loading, or
    // an archived thread): a session PATCH here would silently not affect
    // the pinned active thread, so the picker must disable instead.
    renderHeader(undefined, "th-unknown");
    const trigger = screen.getByRole("button", { name: /^Choose model:/ }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });

  it("announces the runtime model while the active thread is unresolved", () => {
    activeModel("th-unknown", "anthropic/claude-opus-4-7");

    renderHeader(undefined, "th-unknown", {
      ...baseSession(),
      model: "claude-sonnet-4-5",
      reasoning: "high",
    });

    const trigger = screen.getByRole("button", {
      name: "Choose model: Opus 4.7",
      description:
        "Model for this thread (pinned at creation). New threads use the workspace default.",
    }) as HTMLButtonElement;
    expect(trigger.textContent).toContain("Opus 4.7");
    expect(trigger.textContent).not.toContain("High");
    expect(trigger.disabled).toBe(true);
  });

  it("stays session-scoped and enabled when no threadId is in play", () => {
    renderHeader(undefined, undefined);
    const trigger = screen.getByRole("button", { name: /^Choose model:/ }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
  });
});

describe("SessionHeader — reasoning persistence", () => {
  it("session-scoped: persists via patchSession when no threadId is in play", async () => {
    const user = userEvent.setup();
    renderHeader(undefined, undefined);

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    // No org reasoning cap in this suite's settings mock, so `levelsUpTo`
    // renders the full vocabulary — "High" is always present.
    await user.click(screen.getByRole("button", { name: "High reasoning" }));

    expect(setReasoningMutate).toHaveBeenCalledWith("high");
    expect(setThreadReasoningMutate).not.toHaveBeenCalled();
  });

  it("thread-scoped: persists via patchThread against the active thread", async () => {
    headerThreads = [{ id: "th-1", sessionId: "sess-1", createdAt: 1 }];
    const user = userEvent.setup();
    renderHeader(undefined, "th-1");

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    await user.click(screen.getByRole("button", { name: "High reasoning" }));

    expect(setThreadReasoningMutate).toHaveBeenCalledWith({ threadId: "th-1", reasoning: "high" });
    expect(setReasoningMutate).not.toHaveBeenCalled();
  });

  it("displays the active thread's reasoning pin over the session default", () => {
    headerThreads = [{ id: "th-1", sessionId: "sess-1", createdAt: 1, reasoning: "xhigh" }];
    renderHeader(undefined, "th-1");
    const trigger = screen.getByRole("button", { name: /^Choose model:/ });
    expect(trigger.textContent).toContain("X-High");
  });
});

describe("SessionHeader — pause control", () => {
  it("disables the pause button while the sandbox is not ready", () => {
    renderHeader({ state: "provisioning", epoch: 1 });
    const button = screen.getByRole("button", { name: /pause/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("enables the pause button once the sandbox is ready and posts on click", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    const button = screen.getByRole("button", { name: /pause/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await user.click(button);
    expect(pauseMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("surfaces the mutation's error text verbatim on a 409", async () => {
    pauseMutateAsync = vi.fn().mockRejectedValue(new Error("a turn is running"));
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: /pause/i }));

    await waitFor(() => {
      expect(screen.getByText("a turn is running")).toBeTruthy();
    });
  });
});

describe("SessionHeader — overflow menu", () => {
  it("clears an active phone rating and disables ratings while saving", async () => {
    sessionRating = "positive";
    const view = renderHeader({ state: "ready", epoch: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    const good = screen.getByRole("menuitemcheckbox", { name: "Good session" });
    expect(good.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(good);
    expect(rateSessionMutate).toHaveBeenCalledWith(null);
    view.unmount();
    ratingPending = true;
    renderHeader({ state: "ready", epoch: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Bad session" }).getAttribute("data-disabled")).not.toBeNull();
  });

  it("keeps phone pause readiness and failure reporting", async () => {
    pauseMutateAsync = vi.fn().mockRejectedValue(new Error("Wait for the current turn to finish."));
    const view = renderHeader({ state: "suspended", epoch: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.getByRole("menuitem", { name: "Pause session" }).getAttribute("data-disabled")).not.toBeNull();
    view.unmount();
    renderHeader({ state: "ready", epoch: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Pause session" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Wait for the current turn to finish.");
  });

  it("has no direct trash button; the ⋯ menu holds Replace sandbox and Delete session", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    expect(screen.queryByRole("button", { name: "Delete session" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.getByRole("menuitem", { name: /replace sandbox/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /delete session/i })).toBeTruthy();
  });

  it("Replace sandbox posts the replace mutation without any confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    expect(replaceMutateAsync).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("surfaces the replace mutation's 409 error text verbatim", async () => {
    replaceMutateAsync = vi.fn().mockRejectedValue(new Error("a turn is running. Wait for it to finish, then retry."));
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    await waitFor(() => {
      expect(screen.getByText(/a turn is running/i)).toBeTruthy();
    });
  });

  /**
   * Delete used to sit behind `window.confirm`. That is not a confirmation
   * for an agent or a scripted client — browser automation accepts the
   * native prompt before a person ever sees the question — so the menu item
   * must OPEN the dialog and delete nothing on its own.
   */
  it("Delete session opens a confirm dialog and deletes nothing yet", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete this session permanently?")).toBeTruthy();
    // The one string the old prompt carried, still carried: what is lost.
    expect(
      within(dialog).getByText(
        "This deletes all threads, history, and child sessions, and tears down the sandbox.",
      ),
    ).toBeTruthy();
    expect(deleteMutateAsync).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("confirming the dialog deletes with the same argument as before", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete session" }));

    expect(deleteMutateAsync).toHaveBeenCalledWith("sess-1");
  });

  it("cancelling the dialog does not delete", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(deleteMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

/**
 * TKAI-253 — the user's own assistant page must not offer Delete session.
 * The v1 holdover deleted the orchestrator and all of its threads; Replace
 * sandbox covers the reset. The item also FAILS CLOSED while the assistants
 * list or the orchestrator probe is still loading — in that window every
 * session looks like a plain session, and the gate must not flash the one
 * destructive action on an assistant page. The team-assistant delete keeps
 * working; see the team assistant describe below.
 */
describe("SessionHeader — no delete on the user's own assistant", () => {
  it("hides Delete session on the orchestrator page, keeps Replace sandbox", async () => {
    isWorkspaceRuntime = true;
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.getByRole("menuitem", { name: /replace sandbox/i })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull();
  });

  it("hides delete on a personal workspace runtime", async () => {
    isWorkspaceRuntime = true;
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.getByRole("menuitem", { name: /replace sandbox/i })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull();
  });

  it("fails closed without a runtime identity", async () => {
    isWorkspaceRuntime = undefined;
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.getByRole("menuitem", { name: /replace sandbox/i })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull();
  });

  it("fails closed when a detail response omits runtime identity", async () => {
    isWorkspaceRuntime = undefined;
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.getByRole("menuitem", { name: /replace sandbox/i })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull();
  });

  it("surfaces a failed delete's error text instead of swallowing it", async () => {
    deleteMutateAsync.mockRejectedValueOnce(new Error("a turn is running"));
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete session" }));

    // Inside the dialog, not behind it: the modal covers the header's own
    // error slot, and `window.confirm` could not have shown this at all.
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByText("a turn is running")).toBeTruthy(),
    );
  });
});

/**
 * V1 port #2 — Terminal and VS Code on any session. `SandboxTabs` shows the
 * tab strip only for a `full` profile, and the profile was frozen at
 * creation, so an assistant session could never reach it. The switch lives
 * in the ⋯ menu rather than as a silent default, because raising the
 * profile restarts the sandbox and starts two more services in it.
 */
describe("SessionHeader — Terminal and VS Code switch", () => {
  function renderWithProfile(profile: "headless" | "full") {
    return render(
      <TooltipProvider>
        <SessionHeader
          session={{ ...baseSession(), profile }}
          agentStatus="idle"
          conn="open"
          sandbox={{ state: "ready", epoch: 1 }}
        />
      </TooltipProvider>,
    );
  }

  it("offers to turn the services on for a headless session", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const user = userEvent.setup();
    renderWithProfile("headless");

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /turn on terminal and vs code/i }));

    // The menu item asks; it does not restart the sandbox. A native
    // confirm() is auto-accepted by browser automation, so the restart used
    // to happen with nobody having answered the question.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Turn on Terminal and VS Code?")).toBeTruthy();
    expect(setProfileMutateAsync).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    expect(setProfileMutateAsync).toHaveBeenCalledWith("full");
    confirmSpy.mockRestore();
  });

  it("offers to turn them off again for a full session", async () => {
    const user = userEvent.setup();
    renderWithProfile("full");

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /turn off terminal and vs code/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Turn off Terminal and VS Code?")).toBeTruthy();
    expect(setProfileMutateAsync).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    expect(setProfileMutateAsync).toHaveBeenCalledWith("headless");
  });

  it("names the cost before restarting the sandbox", async () => {
    const user = userEvent.setup();
    renderWithProfile("headless");

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /turn on terminal and vs code/i }));

    const dialog = await screen.findByRole("dialog");
    const cost = within(dialog).getByText(/restarts/i);
    expect(cost.textContent).toMatch(/files are kept/i);

    // A cancelled dialog changes nothing.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(setProfileMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("surfaces the server's error text", async () => {
    setProfileMutateAsync = vi
      .fn()
      .mockRejectedValue(new Error("a turn is running. Wait for it to finish, then change the profile."));
    const user = userEvent.setup();
    renderWithProfile("headless");

    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    await user.click(screen.getByRole("menuitem", { name: /turn on terminal and vs code/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));

    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByText(/a turn is running/i)).toBeTruthy(),
    );
  });

  it("hides the switch from a plain team member", async () => {
    // Same rule as pause and delete: the switch restarts a sandbox the
    // whole team shares, so it follows `canAdminister`.
    teamsData = {
      teams: [
        {
          id: "team_1",
          orgId: "org_1",
          name: "Platform",
          origin: "local",
          externalId: null,
          createdAt: 1,
          memberCount: 3,
          callerRole: "member", defaultModel: null,
        },
      ],
    };
    render(
      <TooltipProvider>
        <SessionHeader
          session={{ ...baseSession(), id: "assistant:asst_team", isWorkspaceRuntime: true, owner: { type: "team", id: "team_1" } }}
          agentStatus="idle"
          conn="open"
        />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.queryByRole("menuitem", { name: /turn .*terminal/i })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /delete|replace|pause/i })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Copy transcript" })).toBeTruthy();
  });
});

/**
 * A team's assistant is a shared session. Two things must hold that did not
 * before: it is titled with its own name, or failing that the TEAM's (the
 * header used to fall through to `useOrchestratorInfo`, i.e. the VIEWER's
 * own assistant name, for any id starting `orchestrator:`), and its
 * lifecycle controls are team-admin only — the API enforces the same rule,
 * so showing them to a plain member would only offer a 404.
 *
 * Ownership comes from the assistants list, not from parsing the session id.
 * The id used to carry the owning principal, which addressed exactly one
 * assistant per team and could not survive the second one.
 */
/**
 * V1 port #10 — the inline-editable title. The auto-titler is the only
 * writer of `session.title` otherwise, and it is often wrong, so the header
 * has to offer a correction. Renaming follows the same `canAdminister` rule
 * as the model picker, pause, and delete.
 */
describe("SessionHeader — rename", () => {
  it("opens an edit box seeded with the current title", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Rename session: Fix the bug" }));
    const box = screen.getByLabelText("Session title");
    expect(box).toBeInstanceOf(HTMLInputElement);
    expect((box as HTMLInputElement).value).toBe("Fix the bug");
  });

  it("saves the trimmed title once on Enter", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Rename session: Fix the bug" }));
    await user.clear(screen.getByLabelText("Session title"));
    await user.type(screen.getByLabelText("Session title"), "  Ship the parser  {Enter}");

    await waitFor(() => expect(renameMutateAsync).toHaveBeenCalledTimes(1));
    // Enter unmounts the input, which fires blur straight after. One edit
    // must still send one PATCH.
    expect(renameMutateAsync).toHaveBeenCalledWith("Ship the parser");
  });

  it("saves on blur", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Rename session: Fix the bug" }));
    await user.clear(screen.getByLabelText("Session title"));
    await user.type(screen.getByLabelText("Session title"), "Renamed by blur");
    await user.tab();

    await waitFor(() => expect(renameMutateAsync).toHaveBeenCalledWith("Renamed by blur"));
  });

  it("discards the edit on Escape", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Rename session: Fix the bug" }));
    await user.clear(screen.getByLabelText("Session title"));
    await user.type(screen.getByLabelText("Session title"), "Never saved{Escape}");

    expect(renameMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rename session: Fix the bug" })).toBeTruthy();
  });

  it("sends nothing when the title is unchanged or emptied", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Rename session: Fix the bug" }));
    await user.type(screen.getByLabelText("Session title"), "{Enter}");
    expect(renameMutateAsync).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Rename session: Fix the bug" }));
    await user.clear(screen.getByLabelText("Session title"));
    await user.type(screen.getByLabelText("Session title"), "{Enter}");
    // The server rejects an empty title, so an emptied box means "cancel".
    expect(renameMutateAsync).not.toHaveBeenCalled();
  });

  it("surfaces a failed rename with the server's message", async () => {
    renameMutateAsync = vi
      .fn()
      .mockRejectedValue(new Error("title is too long. Use 200 characters or fewer."));
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Rename session: Fix the bug" }));
    await user.clear(screen.getByLabelText("Session title"));
    await user.type(screen.getByLabelText("Session title"), "Too long{Enter}");

    await waitFor(() =>
      expect(screen.getByText("title is too long. Use 200 characters or fewer.")).toBeTruthy(),
    );
  });
});

describe("SessionHeader — team assistant", () => {
  function teamSession(): SessionDetail {
    return { ...baseSession(), id: "assistant:asst_team", title: "Assistant", isWorkspaceRuntime: true, owner: { type: "team", id: "team_1" } };
  }

  function renderTeamHeader() {
    return render(
      <TooltipProvider>
        <SessionHeader session={teamSession()} agentStatus="idle" conn="open" />
      </TooltipProvider>,
    );
  }

  function withTeam(callerRole: "admin" | "member" | null, _assistantName?: string) {
    teamsData = {
      teams: [
        {
          id: "team_1",
          orgId: "org_1",
          name: "Platform",
          origin: "local",
          externalId: null,
          createdAt: 1,
          memberCount: 3,
          callerRole,
          defaultModel: null,
        },
      ],
    };
  }

  it("titles an unnamed team assistant the way the rail does, not with the viewer's own name", () => {
    withTeam("member");
    renderTeamHeader();
    // The same `assistantLabel` the rail uses. It used to fall back to the
    // TEAM's name here, so one assistant was called "Default Orchestrator" in
    // the rail and "Platform" in the header — two names for one thing.
    expect(screen.getByText("New thread")).toBeTruthy();
    // The guarantee this test has always been about: never the viewer's own
    // assistant name.
    expect(screen.queryByText("Assistant")).toBeNull();
    // The team is still named, on the badge, so dropping it from the title
    // costs no information.
    expect(screen.getByText("Platform")).toBeTruthy();
  });

  it("titles a named team assistant with its own name", () => {
    // A team owns several, so the team's name no longer identifies which
    // conversation you are reading.
    withTeam("member", "Triage");
    renderTeamHeader();
    expect(screen.getByText("New thread")).toBeTruthy();
  });

  it("marks it as shared with a badge naming the owning team", () => {
    withTeam("member");
    renderTeamHeader();
    // Queried as the BADGE, not as text anywhere in the header. Asserting the
    // text alone would be satisfied by any element carrying it, so the test
    // would stop being about the badge the moment something else rendered the
    // team's name — which is exactly what the title used to do.
    //
    // The team's own name, not the bare word "Team": a person on several
    // teams cannot tell them apart from a generic label.
    expect(screen.getByTestId("owning-team").textContent).toBe("Platform");
  });

  /**
   * The workspace chip is a real filesystem path on a real session, but an
   * assistant's is synthetic — `~/.valet/orchestrator/{type}-{id}` — and
   * on a team it rendered as `team-team_99235d43-…`, the principal type
   * joined to an id that already carries it. An internal identifier, shown
   * to a user, for no reason. These two cases pin that it stays hidden.
   */
  it("does not show the internal workspace path on a team assistant", () => {
    withTeam("member");
    render(
      <TooltipProvider>
        <SessionHeader
          session={{ ...teamSession(), workspace: "/root/.valet/orchestrator/team-team_1" }}
          agentStatus="idle"
          conn="open"
        />
      </TooltipProvider>,
    );
    expect(screen.queryByText(/team-team_1/)).toBeNull();
    expect(screen.queryByText(/orchestrator/)).toBeNull();
  });

  it("still shows the workspace on an ordinary session, where it names a real place", () => {
    withTeam("member");
    render(
      <TooltipProvider>
        <SessionHeader session={baseSession()} agentStatus="idle" conn="open" />
      </TooltipProvider>,
    );
    expect(screen.getByText("repo")).toBeTruthy();
  });

  it("keeps phone copy and ratings available without team admin actions", async () => {
    withTeam("member");
    renderTeamHeader();
    expect(screen.queryByRole("button", { name: /pause/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.queryByRole("menuitem", { name: /turn .*terminal/i })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /delete|replace|pause/i })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Copy transcript" })).toBeTruthy();
  });

  it("shows pause and the session menu to a team admin", () => {
    withTeam("admin");
    renderTeamHeader();
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Thread menu" })).toBeTruthy();
  });

  it("never offers move or delete for a team workspace runtime, including to admins", async () => {
    withTeam("admin");
    const user = userEvent.setup();
    renderTeamHeader();
    await user.click(screen.getByRole("button", { name: "Thread menu" }));
    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /move to workspace/i })).toBeNull();
    expect(deleteMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps the controls on a personal session", () => {
    renderHeader({ state: "ready", epoch: 1 });
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Thread menu" })).toBeTruthy();
  });

  // An assistant's header shows the ASSISTANT's name, not `session.title`.
  // An edit box here would store a string the header never reads back.
  it("offers no rename on an assistant session, even to a team admin", () => {
    withTeam("admin", "Triage");
    renderTeamHeader();
    expect(screen.getByText("New thread")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Rename session/ })).toBeNull();
  });
});
