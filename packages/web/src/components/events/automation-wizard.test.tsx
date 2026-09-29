// @vitest-environment jsdom
/**
 * AutomationWizard — one outcome-first flow that writes to the right store per
 * outcome.
 *
 * These cases pin the wire body each outcome posts, following the
 * isolate-from-the-network pattern the other web suites use: `~/api/*` is
 * mocked to record what its mutations receive.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  CreateEventSubscriptionRequest,
  CreateWorkflowScheduleRequest
} from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const createSubscription = vi.fn();
const createSchedule = vi.fn();

const catalogData = {
  services: [
    {
      service: "github",
      entries: [
        {
          key: "github.pr.opened",
          description: "A pull request was opened",
          filters: [{ field: "branch", description: "Base branch" }],
        },
      ],
    },
  ],
};

vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: catalogData, isLoading: false, error: null }),
  useCreateEventSubscription: () => ({ mutate: createSubscription, isPending: false }),
  // The reply outcome's channel multi-select calls this. The source cannot
  // resolve here — return a reason so it falls back to the free-text
  // channel-id input the reply tests type into.
  useFilterOptions: () => ({ data: { options: [], reason: "Connect Slack first." }, isLoading: false }),
}));

// The assistant picker reads this list. One assistant per owner by default, so
// the picker stays hidden and these cases pin the no-choice wire body; the
// dedicated picker cases below re-mock it with several.
let assistantsData: { assistants: unknown[] } = {
  assistants: [
    { id: "a-mine", name: "Mine", owner: { type: "user", id: "u1" } },
  ],
};

// The reply step warns when the caller's Slack account is not linked.
vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({
    data: {
      links: [
        {
          provider: "slack",
          linked: true,
          channelReady: true,
          codeDelivery: true,
          memberSearch: true,
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
}));

let workflowsData: { workflows: { id: string; name: string }[] } = { workflows: [] };
vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
  useCreateSchedule: () => ({ mutate: createSchedule, isPending: false }),
}));

let teamsData: { teams: { id: string; name: string; memberCount: number }[] } = {
  teams: [{ id: "t_platform", name: "Platform", memberCount: 3 }],
};
vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
}));

// Drive the active workspace: default personal, a team when `scopeTeamId` set.
let scopeTeamId: string | undefined;
vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return {
    ...actual,
    useWorkspaceScope: () => ({
      key: scopeTeamId ?? "user",
      teamId: scopeTeamId,
      available: ["user"],
      setKey: () => {},
    }),
  };
});

import { ApiError } from "~/api/client";
import { AutomationWizard } from "./automation-wizard";

beforeEach(() => {
  createSubscription.mockReset();
  createSchedule.mockReset();
  workflowsData = { workflows: [] };
  teamsData = { teams: [{ id: "t_platform", name: "Platform", memberCount: 3 }] };
  assistantsData = {
    assistants: [
      { id: "a-mine", name: "Mine", owner: { type: "user", id: "u1" } },
    ],
  };
});

afterEach(() => {
  scopeTeamId = undefined;
});

function clickNext() {
  fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
}

function pickOutcome(label: RegExp) {
  fireEvent.click(screen.getByLabelText(label));
}

describe("AutomationWizard", () => {
  it("reviews a Slack thread permalink before creating an exact thread subscription", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    pickOutcome(/Subscribe to thread/);
    expect(createSubscription).not.toHaveBeenCalled();
    clickNext();
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Slack thread link"), {
      target: { value: "https://acme.slack.com/archives/C123ABC/p1750000000123456" },
    });
    expect(createSubscription).not.toHaveBeenCalled();
    clickNext();
    expect((screen.getByLabelText(/Notify your personal workspace/) as HTMLInputElement).checked).toBe(true);
    expect(createSubscription).not.toHaveBeenCalled();
    clickNext();
    const review = within(screen.getByLabelText("Automation review"));
    expect(review.getByText("When").nextElementSibling?.textContent).toBe("slack.message");
    expect(review.getByText("Scope").nextElementSibling?.textContent).toContain("C123ABC");
    expect(review.getByText("Scope").nextElementSibling?.textContent).toContain("1750000000.123456");
    expect((screen.getByRole("button", { name: /Create automation/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Follow rollout thread" } });
    expect(createSubscription).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    expect(createSubscription).toHaveBeenCalledTimes(1);
    expect(createSchedule).not.toHaveBeenCalled();
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("Follow rollout thread");
    expect(body.eventKeys).toEqual(["slack.message"]);
    expect(body.filters).toEqual([
      { field: "channel", op: "eq", value: "C123ABC" },
      { field: "thread_ts", op: "eq", value: "1750000000.123456" },
    ]);
    expect(body.target).toEqual({ kind: "orchestrator", orchestrator: "user", follow: false, deliveryPolicy: "always", pauseOnOverlap: true });
  });

  /** Adds a channel through the reply step's free-text fallback (the mocked
   * options source returns a reason, so no picker list renders). */
  function addReplyChannel(id: string) {
    fireEvent.change(screen.getByLabelText("Channel id"), { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: /^Add channel$/ }));
  }

  it("homepage setup requires channels and an explicit team assistant, then saves that target", () => {
    assistantsData = { assistants: [
      { id: "a-team", name: "Reviewer", owner: { type: "team", id: "t_platform" } },
      { id: "a-other", name: "Other", owner: { type: "team", id: "t_other" } },
    ] };
    render(<AutomationWizard open onOpenChange={() => {}} replyTeam={{ id: "t_platform", name: "Platform" }} />);
    expect(screen.getByRole("heading", { name: "Set up Slack replies" })).toBeTruthy();
    expect(screen.queryByText("What should happen?")).toBeNull();
    expect(screen.queryByLabelText("Personal workspace")).toBeNull();
    expect(screen.queryByText("Other")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Any channel/ })).toBeNull();
    addReplyChannel("C123");
    expect(screen.queryByLabelText("Assistant")).toBeNull();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
    clickNext();
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Platform replies" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    expect(createSubscription.mock.calls[0][0]).toMatchObject({
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C123" }],
      target: { kind: "orchestrator", orchestrator: "team", teamId: "t_platform", follow: true },
    });
  });

  it("homepage setup opens on the organization audience and posts it", () => {
    assistantsData = { assistants: [
      { id: "a-team", name: "Reviewer", owner: { type: "team", id: "t_platform" } },
    ] };
    render(<AutomationWizard open onOpenChange={() => {}} replyTeam={{ id: "t_platform", name: "Platform" }} />);
    const anyone = screen.getByLabelText(/Anyone in the organization/) as HTMLInputElement;
    expect(anyone.checked).toBe(true);
    expect((screen.getByLabelText(/Only members of Platform/) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/answers explicit mentions in the selected channels/)).toBeTruthy();
    // Thread following is on by default, so the copy must not read as
    // "explicit mentions only".
    expect(screen.getByText(/from anyone in that thread/)).toBeTruthy();
    expect(screen.getByText(/whoever sends them/)).toBeTruthy();
    expect(screen.getByText(/runs with the team's access and tools/)).toBeTruthy();
    expect(screen.getByText(/does not run or change the team's workflows/)).toBeTruthy();
    addReplyChannel("C123");
    clickNext();
    expect(screen.getByText(/any member of the organization/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Platform replies" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    expect(createSubscription.mock.calls[0][0].audience).toBe("organization");
  });

  it("the team-only audience posts audience team", () => {
    assistantsData = { assistants: [
      { id: "a-team", name: "Reviewer", owner: { type: "team", id: "t_platform" } },
    ] };
    render(<AutomationWizard open onOpenChange={() => {}} replyTeam={{ id: "t_platform", name: "Platform" }} />);
    fireEvent.click(screen.getByLabelText(/Only members of Platform/));
    addReplyChannel("C123");
    clickNext();
    expect(screen.getByText(/any linked member of Platform/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Platform replies" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    expect(createSubscription.mock.calls[0][0].audience).toBe("team");
  });

  it("a personal reply rule carries no audience", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    expect(screen.queryByLabelText(/Anyone in the organization/)).toBeNull();
    addReplyChannel("C123");
    clickNext();
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    expect(createSubscription.mock.calls[0][0].audience).toBeUndefined();
  });

  it("reply outcome posts slack.app_mention with the picked channel and follow ON", () => {
    // The team workspace seeds the team assistant.
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);

    // Step 1 — What: reply is the default. Next.
    clickNext();

    // Step 2 — Reply: channels are required now, so add one, and leave
    // follow ON (default). The team radio is available.
    expect(screen.getByText(/The team owns and administers the assistant/)).toBeTruthy();
    addReplyChannel("C123");
    const teamRadio = screen.getByRole("radio", { name: "Platform" }) as HTMLInputElement;
    expect(teamRadio.disabled).toBe(false);
    fireEvent.click(teamRadio);
    expect(teamRadio.checked).toBe(true);
    // Follow is a checkbox, default checked.
    const follow = screen.getByRole("checkbox", { name: /Keep following the thread/ });
    expect((follow as HTMLInputElement).checked).toBe(true);
    clickNext();

    // Step 3 — Review: name it, create.
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Slack replies" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    expect(createSchedule).not.toHaveBeenCalled();
    expect(createSubscription).toHaveBeenCalledTimes(1);
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("Slack replies");
    expect(body.eventKeys).toEqual(["slack.app_mention"]);
    expect(body.filters).toEqual([{ field: "channel", op: "eq", value: "C123", label: "C123" }]);
    expect(body.anyChannel).toBeUndefined();
    expect(body.target).toEqual({ kind: "orchestrator", orchestrator: "team", teamId: "t_platform", follow: true });
  });

  it("reply step offers the team target with member-only copy", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);
    expect(screen.getByText(/An assistant answers Slack @-mentions/)).toBeTruthy();
    clickNext();
    expect(screen.getByText(/This rule uses the organization/)).toBeTruthy();
    expect(screen.getByText(/Choose below who may invoke it by mention/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Platform" }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/no linked Slack account is always denied/)).toBeTruthy();
    // The review describes the selected team's member scope.
    addReplyChannel("C123");
    clickNext();
    const review = within(screen.getByLabelText("Automation review"));
    expect(review.getByText("Destination").nextElementSibling?.textContent).toBe("notify Platform's assistant");
    expect(review.getByText("Result").nextElementSibling?.textContent).toContain("notify Platform's assistant");
  });

  it("a personal reply rule in a team workspace keeps creator-only copy and target", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    fireEvent.click(screen.getByLabelText(/^Personal workspace/));
    expect(screen.getByText(/do not reach your assistant/)).toBeTruthy();
    addReplyChannel("C123");
    clickNext();
    expect(screen.getByText(/Mentions by other people do not fire it/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Personal" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    expect(createSubscription.mock.calls[0][0].target).toEqual({ kind: "orchestrator", orchestrator: "user", follow: true, deliveryPolicy: "always", pauseOnOverlap: true });
  });

  it("a team reply rule keeps the selected assistant through review and create", () => {
    scopeTeamId = "t_platform";
    assistantsData = { assistants: [
      { id: "team-default", name: "Default", owner: { type: "team", id: "t_platform" } },
      { id: "team-ops", name: "Ops", owner: { type: "team", id: "t_platform" } },
    ] };
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    addReplyChannel("C123");
    clickNext();
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Team ops" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    expect(createSubscription.mock.calls[0][0].target).toEqual({ kind: "orchestrator", orchestrator: "team", teamId: "t_platform", follow: true });
  });

  it("reply step keeps the org assistant reachable in a team workspace", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    addReplyChannel("C123");
    fireEvent.click(screen.getByLabelText(/The org assistant/));
    expect(screen.getByText(/do not reach the org assistant/)).toBeTruthy();
    clickNext();
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Org replies" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({ kind: "orchestrator", orchestrator: "org", follow: true });
  });

  it("reply outcome posts several channels as one in filter", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // What: reply
    addReplyChannel("C123");
    addReplyChannel("C456");
    clickNext();

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Two rooms" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    // The free-text fallback labels a typed id with itself; the picker path
    // would carry channel names here instead.
    expect(body.filters).toEqual([
      { field: "channel", op: "in", value: ["C123", "C456"], labels: ["C123", "C456"] },
    ]);
  });

  it("reply outcome with Any channel posts no channel filter and the anyChannel flag", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // What: reply

    // Step 2 — Reply: opt out of the channel requirement, turn follow off.
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep following the thread/ }));
    clickNext();

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Ping only" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.eventKeys).toEqual(["slack.app_mention"]);
    expect(body.filters).toEqual([]);
    expect(body.anyChannel).toBe(true);
    // Personal workspace, so the default target is the user's assistant.
    expect(body.target).toEqual({ kind: "orchestrator", orchestrator: "user", follow: false, deliveryPolicy: "always", pauseOnOverlap: true });
  });

  it("blocks Next on the reply step until a channel is picked or Any channel is set", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext(); // What → Reply
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("drops a picked team target when the workspace switches back to personal", () => {
    scopeTeamId = "t_platform";
    const view = render(<AutomationWizard open onOpenChange={() => {}} />);

    pickOutcome(/Send a notification/);
    clickNext(); // What
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext(); // Match

    // The reader moves off the seeded team target and then picks it by hand
    // (a pick, not the seed, is what a workspace switch must not keep), then
    // leaves the team workspace.
    fireEvent.click(screen.getByLabelText(/Notify your personal workspace/));
    fireEvent.click(screen.getByLabelText(/Notify Platform/));
    scopeTeamId = undefined;
    view.rerender(<AutomationWizard open onOpenChange={() => {}} />);

    // The team option is gone, and the held target followed the workspace.
    expect(screen.queryByLabelText(/Notify Platform/)).toBeNull();
    expect((screen.getByLabelText(/Notify your personal workspace/) as HTMLInputElement).checked).toBe(true);
    clickNext(); // Then

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "PR ping" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({ kind: "orchestrator", orchestrator: "user", follow: false, deliveryPolicy: "always", pauseOnOverlap: true });
  });

  it("workflow outcome posts a subscription with a workflow target", () => {
    workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }] };
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickOutcome(/Run a workflow on an event/);
    clickNext(); // What

    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext(); // Match

    fireEvent.click(screen.getByLabelText(/Run a workflow/));
    fireEvent.change(screen.getByLabelText("Workflow"), { target: { value: "wf_1" } });
    clickNext(); // Then

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "PR deploy" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    expect(createSchedule).not.toHaveBeenCalled();
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({ kind: "workflow", workflowId: "wf_1" });
  });

  it("advanced outcome reaches the raw event picker and posts keys, filter, target", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickOutcome(/Advanced \/ custom trigger/);
    clickNext(); // What

    // Step 2 — Match: the raw event picker. Pick the key, add a filter.
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    fireEvent.click(screen.getByText(/^Add filter$/));
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "main" } });
    clickNext();

    // Step 3 — Then: choose the team's assistant.
    fireEvent.click(screen.getByLabelText(/Notify Platform/));
    clickNext();

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "PR watch" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    expect(createSchedule).not.toHaveBeenCalled();
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("PR watch");
    expect(body.eventKeys).toEqual(["github.pr.opened"]);
    expect(body.filters).toEqual([{ field: "branch", op: "eq", value: "main" }]);
    expect(body.target).toEqual({
      kind: "orchestrator",
      orchestrator: "team",
      teamId: "t_platform",
    });
  });

  // The server refuses a bad template by naming the wire field, the way every
  // sibling refusal in that validator does. If the form does not show the same
  // name, a reader told to move a variable to userPromptTemplate is looking for
  // a box that does not exist under that name.
  it("names the wire field beside each prompt label, so a server refusal points somewhere", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));

    const system = screen.getByLabelText(/Instructions for the assistant/);
    const user = screen.getByLabelText(/Event message/);
    expect(system.closest("div")?.textContent).toContain("systemPrompt");
    expect(user.closest("div")?.textContent).toContain("userPromptTemplate");
  });

  it("reply outcome posts the prompt templates it collected on the mention target", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // What. The reply outcome is the default.

    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    fireEvent.change(screen.getByLabelText(/Instructions for the assistant/), {
      target: { value: "Answer in one sentence." },
    });
    fireEvent.change(screen.getByLabelText(/Event message/), {
      target: { value: "Mention: {{event.body}}" },
    });
    clickNext(); // Reply

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Slack replies" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({
      kind: "orchestrator",
      orchestrator: "user",
      deliveryPolicy: "always",
      pauseOnOverlap: true,
      follow: true,
      systemPrompt: "Answer in one sentence.",
      userPromptTemplate: "Mention: {{event.body}}",
    });
  });

  it("notify outcome posts the prompt templates it collected on the assistant target", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickOutcome(/Send a notification/);
    clickNext(); // What

    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext(); // Match

    // Step 3, Then: your assistant, plus what it should read.
    fireEvent.change(screen.getByLabelText(/Instructions for the assistant/), {
      target: { value: "Triage it. Answer in one sentence." },
    });
    fireEvent.change(screen.getByLabelText(/Event message/), {
      target: { value: "{{event.summary}} on {{refs.repo}}" },
    });
    clickNext();

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "PR triage" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({
      kind: "orchestrator",
      orchestrator: "user",
      deliveryPolicy: "always",
      pauseOnOverlap: true,
      follow: false,
      systemPrompt: "Triage it. Answer in one sentence.",
      userPromptTemplate: "{{event.summary}} on {{refs.repo}}",
    });
  });

  it("offers no prompt template on a workflow target, whose prompts live on its nodes", () => {
    workflowsData = { workflows: [{ id: "wf-1", name: "Deploy" }] };
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickOutcome(/Run a workflow on an event/);
    clickNext();
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext();

    expect(screen.queryByLabelText(/Instructions for the assistant/)).toBeNull();
    expect(screen.queryByLabelText(/Event message/)).toBeNull();
  });

  it("schedule outcome posts a schedule with a cron and an orchestrator prompt", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    // Step 1 — What: on a schedule.
    pickOutcome(/On a schedule/);
    clickNext();

    // Step 2 — Match: cron.
    fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "0 9 * * 1-5" } });
    clickNext();

    // Step 3 — Then: default is your assistant. A prompt appears for a
    // scheduled orchestrator run.
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Daily digest" } });
    clickNext();

    // Step 4 — Review.
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Morning digest" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    expect(createSubscription).not.toHaveBeenCalled();
    expect(createSchedule).toHaveBeenCalledTimes(1);
    const body = createSchedule.mock.calls[0][0] as CreateWorkflowScheduleRequest;
    expect(body.name).toBe("Morning digest");
    expect(body.cron).toBe("0 9 * * 1-5");
    expect(body.timezone).toEqual(expect.any(String));
    expect(body.target).toEqual({ kind: "orchestrator", prompt: "Daily digest" });
  });

  it("blocks Next until the advanced Match step has an event", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    pickOutcome(/Advanced \/ custom trigger/);
    clickNext(); // What → Match
    // No event key picked yet: Next is disabled.
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  // ── Collision gate (TKAI-294) ─────────────────────────────────────────────

  /** A collision payload naming one existing rule, as the server builds it. */
  function collisionPayload(kind: "blocking" | "overlapping") {
    const entry = {
      subscription: {
        id: "sub_existing",
        name: "Eng channel replies",
        ownerType: "user",
        ownerId: "u1",
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "C123", label: "#eng" }],
        target: { kind: "orchestrator" },
        enabled: true,
        createdBy: "u1",
        createdAt: 1,
        updatedAt: 1,
      },
      relation: kind === "blocking" ? "superset" : "subset",
      sharedKeys: ["slack.app_mention"],
    };
    return {
      blocking: kind === "blocking" ? [entry] : [],
      overlapping: kind === "overlapping" ? [entry] : [],
    };
  }

  /** Walks the reply flow to Review and presses Create. */
  function createReplyRule(name: string) {
    clickNext(); // What: reply
    addReplyChannel("C123");
    clickNext(); // Reply → Review
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
  }

  it("homepage setup never offers to override a colliding responder", () => {
    assistantsData = { assistants: [{ id: "a-team", name: "Reviewer", owner: { type: "team", id: "t_platform" } }] };
    createSubscription.mockImplementation((_body: unknown, handlers: { onError: (err: Error) => void }) => {
      handlers.onError(new ApiError(409, "collision", { error: "collides", collisions: collisionPayload("blocking") }));
    });
    render(<AutomationWizard open onOpenChange={() => {}} replyTeam={{ id: "t_platform", name: "Platform" }} />);
    addReplyChannel("C123");
    clickNext();
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Platform replies" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));
    expect(screen.getByText("Eng channel replies")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create anyway" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Events" }).getAttribute("href")).toBe("/events");
    expect(createSubscription).toHaveBeenCalledTimes(1);
  });

  it("a 409 collision renders the colliding rule and Create anyway resubmits with allowCollision", () => {
    const onOpenChange = vi.fn();
    createSubscription.mockImplementation(
      (_body: unknown, handlers: { onError: (err: Error) => void }) => {
        handlers.onError(
          new ApiError(409, "collision", {
            error: "collides",
            collisions: collisionPayload("blocking"),
          }),
        );
      },
    );
    render(<AutomationWizard open onOpenChange={onOpenChange} />);
    createReplyRule("Wide net");

    // The colliding rule is named inline; the dialog stays open.
    expect(screen.getByText("Eng channel replies")).toBeTruthy();
    expect(screen.getByText("Would replace")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Create anyway$/ }));
    expect(createSubscription).toHaveBeenCalledTimes(2);
    const first = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(first.allowCollision).toBeUndefined();
    const retry = createSubscription.mock.calls[1][0] as CreateEventSubscriptionRequest;
    expect(retry.allowCollision).toBe(true);
  });

  it("a committed overlap shows the warning and Done closes the dialog", () => {
    const onOpenChange = vi.fn();
    createSubscription.mockImplementation(
      (_body: unknown, handlers: { onSuccess: (resp: { collisions?: unknown }) => void }) => {
        handlers.onSuccess({ collisions: collisionPayload("overlapping") });
      },
    );
    render(<AutomationWizard open onOpenChange={onOpenChange} />);
    createReplyRule("Narrow rule");

    // Saved, but the overlap warning holds the dialog open until Done.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Overlaps")).toBeTruthy();
    expect(screen.getByText("Eng channel replies")).toBeTruthy();
    // The refusal-only actions are gone.
    expect(screen.queryByRole("button", { name: /Create anyway/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Create automation/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Done$/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a clean create still closes the dialog", () => {
    const onOpenChange = vi.fn();
    createSubscription.mockImplementation(
      (_body: unknown, handlers: { onSuccess: (resp: object) => void }) => {
        handlers.onSuccess({ id: "sub_new" });
      },
    );
    render(<AutomationWizard open onOpenChange={onOpenChange} />);
    createReplyRule("Clean rule");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
