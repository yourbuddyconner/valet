// @vitest-environment jsdom
/**
 * TeamsPanel role gating: mutation controls (team actions menu, role
 * dropdown, remove, add-member) render only for a team admin or an org
 * admin. The API enforces the same gate (`canMutateTeam`); this suite pins
 * that the UI stops offering controls that would 404.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Renders a real anchor so `getByRole("link")` and href assertions work
 * without mounting a router. */
function RouterLinkStub({
  to,
  search,
  children,
  className,
}: {
  to: string;
  search?: Record<string, string | undefined>;
  children: ReactNode;
  className?: string;
}) {
  const params = Object.entries(search ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const qs = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  return (
    <a href={`${to}${qs}`} className={className}>
      {children}
    </a>
  );
}

// The request panel has its own real-query integration tests. Keep this suite
// focused on team settings and authority controls.
vi.mock("./team-deletion-requests", () => ({
  TeamDeletionRequests: ({ teamId, canManage }: { teamId: string; canManage: boolean }) =>
    <section aria-label="Deletion requests" data-team-id={teamId} data-can-manage={canManage} />,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: RouterLinkStub,
}));

/** Shared across renders so the add-member tests can assert on the call. */
const addMemberMutate = vi.fn();
const patchTeamMutate = vi.fn();
let addMemberError: Error | null = null;
let addMemberPending = false;

/** Shared across renders so the delete tests can assert on the call. */
const deleteTeamMutate = vi.fn();
let deleteTeamPending = false;
let deleteTeamError: Error | null = null;
/** React Query's `reset` drops the last failure. The stub clears the error
 * the same way, because the delete dialog leans on that to open clean. */
const deleteTeamReset = vi.fn(() => {
  deleteTeamError = null;
});

let callerRole: "admin" | "member" | null = "member";
let orgRole: "admin" | "member" = "member";
let origin: "local" | "config" | "idp" = "local";
let selectedTeamsOverride: TeamSummary[] | undefined;
let selectedTeamsLoading = false;
let selectedTeamsError: Error | null = null;

const teamsData = () => ({
  teams: [
    {
      id: "team_1",
      orgId: "org_1",
      name: "Platform",
      origin,
      externalId: origin === "idp" ? "/platform" : null,
      createdAt: 1,
      memberCount: 2,
      callerRole,
      defaultModel: teamDefaultModel,
      defaultReasoning: teamDefaultReasoning,
    },
  ],
});
let teamDefaultModel: string | null = null;
let teamDefaultReasoning: string | null = null;

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: selectedTeamsOverride ? { teams: selectedTeamsOverride } : teamsData(), isLoading: selectedTeamsLoading, error: selectedTeamsError }),
  useMe: () => ({ data: { orgRole }, isLoading: false, error: null }),
  useTeamMembers: () => ({
    data: {
      members: [
        { userId: "u1", role: "admin" },
        { userId: "u2", role: "member" },
      ],
    },
    isLoading: false,
    error: null,
  }),
  useCreateTeam: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteTeam: () => ({
    mutate: deleteTeamMutate,
    isPending: deleteTeamPending,
    error: deleteTeamError,
    reset: deleteTeamReset,
  }),
  useAddTeamMember: () => ({
    mutate: addMemberMutate,
    isPending: addMemberPending,
    error: addMemberError,
  }),
  useRemoveTeamMember: () => ({ mutate: vi.fn(), isPending: false }),
  useSetTeamMemberRole: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchTeam: () => ({ mutate: patchTeamMutate, isPending: false, error: null }),
  // The default-model combobox reads the org catalog through this hook.
  useModels: () => ({
    data: {
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          providerId: "anthropic",
          providerKind: "anthropic",
          providerName: "Anthropic",
          active: true,
          approved: true,
        },
        {
          id: "custom_1/llama-3",
          name: "Llama 3",
          providerId: "custom_1",
          providerKind: "openai_compatible",
          providerName: "My Router",
          active: true,
          approved: true,
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
  // The Size group (Task 15) reads the org tier map through this hook.
  useModelTiers: () => ({
    data: { xs: [], s: [], m: [], l: [], xl: [] },
    isLoading: false,
    error: null,
  }),
  // The team-defaults reasoning select reads the org cap through this hook.
  useOrgReasoning: () => ({ data: {}, isLoading: false, error: null }),
}));


let teamCredentials: Array<{
  service: string;
  type: "oauth2" | "api_key";
  connectedAt: string;
  delegatedFrom?: string;
  referenceBroken?: boolean;
}> = [];

/** Shared across renders so the disconnect tests can assert on the call. */
const disconnectMutate = vi.fn();
let disconnectPending = false;
let disconnectError: Error | null = null;
/** The arguments the last disconnect ran with. React Query sets this when
 * `mutate` is called, and the panel's per-row error guard reads it. */
let disconnectVariables: { service: string } | undefined;

vi.mock("~/api/integrations", () => ({
  useCredentials: () => ({
    data: { credentials: teamCredentials },
    isLoading: false,
    error: null,
  }),
  useDisconnectCredential: () => ({
    mutate: disconnectMutate,
    isPending: disconnectPending,
    error: disconnectError,
    variables: disconnectVariables,
    reset: vi.fn(),
  }),
}));

import { TeamsPanel } from "./teams-panel";

const orgMembers: OrgDirectoryUserWire[] = [
  { userId: "u1", name: "One", email: "one@dev", avatarUrl: null },
  { userId: "u2", name: "Two", email: "two@dev", avatarUrl: null },
  { userId: "u3", name: "Three", email: "three@dev", avatarUrl: null },
  { userId: "u4", name: "Four", email: "four@dev", avatarUrl: null },
  // u6 sits BEFORE u5 so the prefix-ranking test proves ordering: "ada" is a
  // mid-string match for Zed Prada and a prefix match for Ada Lovelace.
  { userId: "u6", name: "Zed Prada", email: "zprada@dev", avatarUrl: null },
  { userId: "u5", name: "Ada Lovelace", email: "ada@dev", avatarUrl: null },
];

function openTeam() {
  const view = render(<TeamsPanel orgMembers={orgMembers} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand Platform" }));
  return view;
}

describe("TeamsPanel — identity-provider provenance", () => {
  beforeEach(() => {
    callerRole = "admin";
    orgRole = "admin";
    origin = "idp";
  });

  afterEach(() => {
    origin = "local";
  });

  it("shows provenance and keeps manual membership controls", () => {
    openTeam();
    expect(screen.getByText("Identity provider")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Platform actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add member/ })).toBeTruthy();
  });
});

describe("TeamsPanel — team default model (TKAI-255)", () => {
  beforeEach(() => {
    patchTeamMutate.mockClear();
    teamDefaultModel = null;
    teamDefaultReasoning = null;
  });

  it("team admin picks a model → PATCH with the catalog id", () => {
    callerRole = "admin";
    orgRole = "member";
    openTeam();
    const combobox = screen.getByRole("combobox", { name: "Default model" });
    fireEvent.focus(combobox);
    fireEvent.click(screen.getByText("Sonnet 4.5"));
    expect(patchTeamMutate).toHaveBeenCalledWith({
      id: "team_1",
      body: { defaultModel: "anthropic/claude-sonnet-4-5" },
    });
  });

  it("plain member sees the value read-only, no combobox", () => {
    callerRole = "member";
    orgRole = "member";
    teamDefaultModel = "anthropic/claude-sonnet-4-5";
    openTeam();
    expect(screen.queryByRole("combobox", { name: "Default model" })).toBeNull();
    // Curated catalog entry → friendly label, not the raw id.
    expect(screen.getByText("Sonnet 4.5")).toBeTruthy();
    // The hint reaches members too — they are the ones whose sessions the
    // setting shapes, and whose personal default wins.
    expect(screen.getByText(/personal\s+default wins/)).toBeTruthy();
  });

  it("plain member sees the catalog name for a non-curated model, not the raw id", () => {
    callerRole = "member";
    orgRole = "member";
    teamDefaultModel = "custom_1/llama-3";
    openTeam();
    expect(screen.getByText("Llama 3")).toBeTruthy();
    expect(screen.queryByText("custom_1/llama-3")).toBeNull();
  });

  it("plain member with no team override reads 'Organization default' for both model and reasoning", () => {
    callerRole = "member";
    orgRole = "member";
    openTeam();
    expect(screen.getAllByText("Organization default")).toHaveLength(2);
  });

  it("team admin picks a reasoning level → PATCH with the level", () => {
    callerRole = "admin";
    orgRole = "member";
    openTeam();
    fireEvent.change(screen.getByLabelText("Reasoning"), {
      target: { value: "high" },
    });
    expect(patchTeamMutate).toHaveBeenCalledWith({
      id: "team_1",
      body: { defaultReasoning: "high" },
    });
  });

  it("team admin clears reasoning back to Organization default → PATCH with null", () => {
    callerRole = "admin";
    orgRole = "member";
    teamDefaultReasoning = "high";
    openTeam();
    fireEvent.change(screen.getByLabelText("Reasoning"), {
      target: { value: "" },
    });
    expect(patchTeamMutate).toHaveBeenCalledWith({
      id: "team_1",
      body: { defaultReasoning: null },
    });
  });

  it("plain member sees the reasoning value read-only, no select", () => {
    callerRole = "member";
    orgRole = "member";
    teamDefaultReasoning = "high";
    openTeam();
    expect(screen.queryByLabelText("Reasoning")).toBeNull();
    expect(screen.getByText("High")).toBeTruthy();
  });
});

describe("TeamsPanel role gating", () => {
  it("offers a request instead of deletion to a plain team member", async () => {
    callerRole = "member";
    orgRole = "member";
    openTeam();
    await userEvent.click(screen.getByRole("button", { name: "Platform actions" }));
    expect(screen.getByRole("menuitem", { name: "Request deletion" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete team" })).toBeNull();
    expect(screen.getByRole("region", { name: "Deletion requests", hidden: true }).getAttribute("data-can-manage")).toBe("false");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: /Add member/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove One/ })).toBeNull();
    // Both roster roles render as badges, never dropdown triggers. This
    // includes the caller's own row, so the UI offers no self-promotion path.
    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Member" })).toBeNull();
  });

  it("shows mutation controls to a team admin", () => {
    callerRole = "admin";
    orgRole = "member";
    openTeam();
    expect(screen.getByRole("button", { name: "Platform actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add member/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Member" })).toBeTruthy();
  });

  it("shows mutation controls to an org admin who is not on the team", () => {
    callerRole = null;
    orgRole = "admin";
    openTeam();
    expect(screen.getByRole("button", { name: "Platform actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Member" })).toBeTruthy();
  });
});

describe("TeamsPanel — deleting a team", () => {
  /** The 409 a delete gets back while a team workflow run is unsettled, in
   * the words `TeamHasActiveRunsError` uses. */
  const REFUSAL =
    "team team_1 has an unsettled workflow run. Wait for it to finish, or cancel it, then delete the team.";
  /** Enough of it to find in the dialog. */
  const REFUSAL_MATCH = /unsettled workflow run/;

  beforeEach(() => {
    callerRole = "admin";
    orgRole = "member";
    deleteTeamMutate.mockClear();
    deleteTeamReset.mockClear();
  });

  afterEach(() => {
    deleteTeamPending = false;
    deleteTeamError = null;
  });

  /** The menu lives in a portal, and its trigger opens on pointerdown, so
   * these two clicks need a real pointer sequence. */
  async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Platform actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete team" }));
    return screen.findByRole("dialog");
  }

  it("opens the dialog and deletes nothing on the menu click alone", async () => {
    const user = userEvent.setup();
    render(<TeamsPanel orgMembers={orgMembers} />);

    const dialog = await openDeleteDialog(user);
    expect(deleteTeamMutate).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Delete Platform?")).toBeTruthy();
  });

  it("shows the server's refusal after the admin confirms", async () => {
    const user = userEvent.setup();
    const view = render(<TeamsPanel orgMembers={orgMembers} />);

    const dialog = await openDeleteDialog(user);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete team" }));
    expect(deleteTeamMutate).toHaveBeenCalled();

    deleteTeamError = new Error(REFUSAL);
    view.rerender(<TeamsPanel orgMembers={orgMembers} />);

    expect(within(screen.getByRole("dialog")).getByText(REFUSAL_MATCH)).toBeTruthy();
  });

  it("reopens clean after a refused delete, with nothing confirmed yet", async () => {
    // React Query holds `error` until the next mutate, so a dialog that reads
    // it straight through greets the admin with the last attempt's refusal.
    const user = userEvent.setup();
    const view = render(<TeamsPanel orgMembers={orgMembers} />);

    const dialog = await openDeleteDialog(user);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete team" }));
    deleteTeamError = new Error(REFUSAL);
    view.rerender(<TeamsPanel orgMembers={orgMembers} />);
    expect(within(screen.getByRole("dialog")).getByText(REFUSAL_MATCH)).toBeTruthy();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    deleteTeamMutate.mockClear();
    const reopened = await openDeleteDialog(user);
    expect(within(reopened).queryByText(REFUSAL_MATCH)).toBeNull();
    expect(deleteTeamMutate).not.toHaveBeenCalled();
  });
});

describe("TeamsPanel — 1Password connection", () => {
  it("removes reference preferences and shows team token controls", () => {
    callerRole = "admin";
    orgRole = "member";
    openTeam();
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
    expect(screen.queryByText("1Password references")).toBeNull();
    expect(screen.getByLabelText("1Password service account token for Platform")).toBeTruthy();
  });
  it("does not expose token controls to a member", () => {
    callerRole = "member";
    orgRole = "member";
    openTeam();
    expect(screen.queryByRole("button", { name: "Connect token" })).toBeNull();
    expect(screen.getByText("No team token connected. Team runtimes use the organization token when available.")).toBeTruthy();
  });
});

/**
 * The add-member control is a popover typeahead (see `AddMemberPicker`).
 * These tests pin its contract: search narrows the list, the highlight is
 * the Enter target and arrow keys move it, the DOM row count is capped, a
 * failed add is reported, and a member already on the team never appears.
 */
describe("TeamsPanel — add-member picker", () => {
  beforeEach(() => {
    callerRole = "admin";
    orgRole = "admin";
    addMemberMutate.mockClear();
    addMemberError = null;
    addMemberPending = false;
  });

  function openPicker() {
    openTeam();
    fireEvent.click(screen.getByRole("button", { name: /Add member/ }));
  }

  // Scoped to the picker's own listbox: the team-defaults reasoning
  // <select> also renders native <option> elements (role "option") on the
  // same page, which an unscoped query would pick up too.
  function pickerOptions() {
    return within(screen.getByRole("listbox"));
  }

  it("opens a search input listing only members not on the team", () => {
    openPicker();
    expect(screen.getByRole("combobox", { name: /Search members/ })).toBeTruthy();
    // u1/u2 are on the team already; the addable list is the other three.
    expect(screen.getByRole("option", { name: /Three/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Four/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Ada Lovelace/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /One/ })).toBeNull();
  });

  it("filters by name and by email as the query changes", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.change(input, { target: { value: "love" } });
    expect(screen.getByRole("option", { name: /Ada Lovelace/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Three/ })).toBeNull();
    fireEvent.change(input, { target: { value: "four@dev" } });
    expect(screen.getByRole("option", { name: /Four/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Ada Lovelace/ })).toBeNull();
  });

  it("says so when nothing matches", () => {
    openPicker();
    fireEvent.change(screen.getByRole("combobox", { name: /Search members/ }), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matching members.")).toBeTruthy();
    expect(pickerOptions().queryByRole("option")).toBeNull();
  });

  it("adds a member on click", () => {
    openPicker();
    fireEvent.click(screen.getByRole("option", { name: /Ada Lovelace/ }));
    expect(addMemberMutate).toHaveBeenCalledWith({
      teamId: "team_1",
      body: { userId: "u5", role: "member" },
    });
  });

  it("marks the highlighted row as the Enter target", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.change(input, { target: { value: "@dev" } });
    const options = pickerOptions().getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options[1]?.getAttribute("aria-selected")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
  });

  it("moves the highlight with arrow keys and adds it on Enter", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = pickerOptions().getAllByRole("option");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    fireEvent.keyDown(input, { key: "Enter" });
    // Addable order is u3, u4, …; one ArrowDown lands on u4.
    expect(addMemberMutate).toHaveBeenCalledWith({
      teamId: "team_1",
      body: { userId: "u4", role: "member" },
    });
  });

  it("ranks a prefix match above a mid-string match", () => {
    openPicker();
    fireEvent.change(screen.getByRole("combobox", { name: /Search members/ }), {
      target: { value: "ada" },
    });
    const options = pickerOptions().getAllByRole("option");
    // Zed Prada precedes Ada Lovelace in the roster; the prefix match wins.
    expect(options[0]?.textContent).toContain("Ada Lovelace");
    expect(options[1]?.textContent).toContain("Zed Prada");
  });

  it("ignores the Enter that commits an IME composition", () => {
    openPicker();
    fireEvent.keyDown(screen.getByRole("combobox", { name: /Search members/ }), {
      key: "Enter",
      isComposing: true,
    });
    expect(addMemberMutate).not.toHaveBeenCalled();
  });

  it("caps the rendered rows and says how many are hidden", () => {
    const many: OrgDirectoryUserWire[] = Array.from({ length: 60 }, (_, i) => ({
      userId: `x${i}`,
      name: `User ${String(i).padStart(2, "0")}`,
      email: `x${i}@dev`,
      avatarUrl: null,
    }));
    render(<TeamsPanel orgMembers={[...orgMembers.slice(0, 2), ...many]} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Platform" }));
    fireEvent.click(screen.getByRole("button", { name: /Add member/ }));
    expect(pickerOptions().getAllByRole("option")).toHaveLength(50);
    expect(screen.getByText(/10 more matches/)).toBeTruthy();
  });

  it("keeps the trigger mounted but inert when nobody is addable", () => {
    // u1 and u2 are both on the team, so nothing is addable.
    render(<TeamsPanel orgMembers={orgMembers.slice(0, 2)} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Platform" }));
    const trigger = screen.getByRole("button", { name: /Add member/ });
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("combobox", { name: /Search members/ })).toBeNull();
  });

  it("reports a failed add next to the picker", () => {
    addMemberError = new Error("You are not an admin of this team.");
    openTeam();
    expect(screen.getByText(/Failed to add the member/)).toBeTruthy();
  });

  it("adds the first match on Enter", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.change(input, { target: { value: "ada" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(addMemberMutate).toHaveBeenCalledWith({
      teamId: "team_1",
      body: { userId: "u5", role: "member" },
    });
  });

  it("does not add on Enter when nothing matches", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.change(input, { target: { value: "zzz" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(addMemberMutate).not.toHaveBeenCalled();
  });
});

describe("TeamsPanel — team credentials", () => {
  beforeEach(() => {
    callerRole = "admin";
    orgRole = "member";
    teamCredentials = [];
    disconnectMutate.mockClear();
  });

  afterEach(() => {
    teamCredentials = [];
    disconnectPending = false;
    disconnectError = null;
    disconnectVariables = undefined;
  });

  it("names the empty place when the team has no credentials", () => {
    openTeam();
    expect(screen.getByText(/No connections added to this team yet/)).toBeTruthy();
  });

  it("lists a delegated row with the delegator name and a broken badge", () => {
    teamCredentials = [
      {
        service: "linear",
        type: "oauth2",
        connectedAt: "2026-09-01T00:00:00Z",
        delegatedFrom: "u2",
        referenceBroken: true,
      },
    ];
    openTeam();
    expect(screen.getByText("Linear MCP")).toBeTruthy();
    expect(screen.getByText("Shared by Two · broken")).toBeTruthy();
    expect(screen.getByText("Broken")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop sharing Linear with Platform" })).toBeTruthy();
  });

  it("hides the removal control from a plain member", () => {
    callerRole = "member";
    teamCredentials = [
      { service: "linear", type: "oauth2", connectedAt: "2026-09-01T00:00:00Z" },
    ];
    openTeam();
    expect(screen.getByText("Stored on the team")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect Linear from Platform" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();
  });
});

/**
 * Removing a team credential asks in the page, not through `window.confirm`.
 * The native call was no confirmation at all for a scripted client (browser
 * automation accepts it), so the first assertion here is that the click alone
 * writes nothing. One route serves both rows, and they cost different things,
 * so each row kind has its own verb and its own note (`removalLabels`).
 */
describe("TeamsPanel — removing a team credential", () => {
  /** linear is stored on the team. slack is shared by Two. */
  const DIRECT = "Disconnect Linear from Platform";
  const SHARED = "Stop sharing Slack with Platform";

  beforeEach(() => {
    callerRole = "admin";
    orgRole = "member";
    disconnectMutate.mockClear();
    teamCredentials = [
      { service: "linear", type: "oauth2", connectedAt: "2026-09-01T00:00:00Z" },
      {
        service: "slack",
        type: "oauth2",
        connectedAt: "2026-09-02T00:00:00Z",
        delegatedFrom: "u2",
      },
    ];
  });

  afterEach(() => {
    teamCredentials = [];
    disconnectPending = false;
    disconnectError = null;
  });

  /** The panel must already be open: a second `openTeam()` would mount a
   * second copy and make every row query ambiguous. */
  async function clickRemove(control: string) {
    fireEvent.click(screen.getByRole("button", { name: control }));
    return screen.findByRole("dialog");
  }

  /** The row button disables itself while a removal runs, so the dialog has
   * to open first and the pending state arrive on the next render. */
  async function dialogWhilePending(control: string) {
    const view = openTeam();
    await clickRemove(control);
    disconnectPending = true;
    view.rerender(<TeamsPanel orgMembers={orgMembers} />);
    return screen.getByRole("dialog");
  }

  it("opens the dialog and removes nothing on the click alone", async () => {
    openTeam();
    const dialog = await clickRemove(DIRECT);
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Disconnect Linear from Platform?")).toBeTruthy();
  });

  it("spells the service the way Integrations does, in the title and the note", async () => {
    // The dialog named the raw service id three times, so one credential read
    // "Linear" on Integrations and in every API refusal, and "linear" here.
    openTeam();
    const dialog = await clickRemove(DIRECT);
    expect(within(dialog).getByText("Disconnect Linear from Platform?")).toBeTruthy();
    expect(within(dialog).getByText(/lose access to Linear\./)).toBeTruthy();
    expect(within(dialog).queryByText(/linear/)).toBeNull();
  });

  it("names the row that was clicked, not the first row", async () => {
    // One dialog serves the whole list, so it must read the row held in
    // state. A single boolean would name whichever row rendered first.
    openTeam();
    const dialog = await clickRemove(SHARED);
    expect(within(dialog).getByText("Stop sharing Slack with Platform?")).toBeTruthy();
    expect(within(dialog).queryByText("Disconnect Linear from Platform?")).toBeNull();
  });

  it("calls a delegated row Stop sharing, and says the delegator keeps theirs", async () => {
    // "Disconnect slack" beside a row shared by Two read as though it would
    // drop Two's own connection. The Integrations share menu already calls
    // this action "Stop sharing" (`integrations/share-with-team.test.tsx`).
    openTeam();
    expect(screen.getByRole("button", { name: SHARED }).textContent).toBe("Stop sharing");
    expect(screen.queryByRole("button", { name: "Disconnect Slack from Platform" })).toBeNull();

    const dialog = await clickRemove(SHARED);
    expect(within(dialog).getByRole("button", { name: "Stop sharing" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(within(dialog).getByText(/removes the team's link only/)).toBeTruthy();
    expect(within(dialog).getByText(/Two keeps their own Slack connection/)).toBeTruthy();
  });

  it("keeps Disconnect for the team's own credential, and says how to get it back", async () => {
    openTeam();
    expect(screen.getByRole("button", { name: DIRECT }).textContent).toBe("Disconnect");

    const dialog = await clickRemove(DIRECT);
    expect(within(dialog).getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Stop sharing" })).toBeNull();
    expect(within(dialog).getByText(/deletes the credential stored on the team/)).toBeTruthy();
    expect(within(dialog).getByText(/Connect Linear again from Integrations/)).toBeTruthy();
  });

  it("confirming removes with the team scope and id", async () => {
    openTeam();
    const dialog = await clickRemove(DIRECT);
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    expect(disconnectMutate).toHaveBeenCalledTimes(1);
    expect(disconnectMutate.mock.calls[0]?.[0]).toEqual({
      service: "linear",
      scope: "team",
      teamId: "team_1",
    });
  });

  it("closes on success", async () => {
    openTeam();
    const dialog = await clickRemove(DIRECT);
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    const options = disconnectMutate.mock.calls[0]?.[1] as { onSuccess: () => void };
    options.onSuccess();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancelling removes nothing and closes the dialog", async () => {
    openTeam();
    const dialog = await clickRemove(DIRECT);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(disconnectMutate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the server error in the dialog instead of swallowing it", async () => {
    disconnectError = new Error("Team not found.");
    disconnectVariables = { service: "linear" };
    openTeam();
    const dialog = await clickRemove(DIRECT);
    expect(within(dialog).getByText(/Team not found\./)).toBeTruthy();
  });

  it("keeps one row's failure off the next row's dialog", async () => {
    // One mutation serves every row, so without the per-row guard the Slack
    // dialog opens on Linear's refusal before anything is clicked in it.
    disconnectError = new Error("Team not found.");
    disconnectVariables = { service: "linear" };
    openTeam();

    const other = await clickRemove(SHARED);
    expect(within(other).queryByText(/Team not found\./)).toBeNull();
  });

  it("says Disconnecting… while a direct removal is in flight", async () => {
    const dialog = await dialogWhilePending(DIRECT);
    expect(within(dialog).getByRole("button", { name: "Disconnecting…" })).toBeTruthy();
  });

  it("says Stopping… while a share removal is in flight", async () => {
    const dialog = await dialogWhilePending(SHARED);
    expect(within(dialog).getByRole("button", { name: "Stopping…" })).toBeTruthy();
  });
});

describe("TeamsPanel — team assistant link", () => {
  beforeEach(() => {
    callerRole = "member";
    orgRole = "member";
  });

  it("shows the Assistant link to a plain member in the active team", () => {
    render(<TeamsPanel orgMembers={orgMembers} teamId="team_1" showAssistantLink />);
    expect(screen.getByRole("link", { name: /Threads/ })).toBeTruthy();
  });

  it("opens the active team's assistants list", () => {
    render(<TeamsPanel orgMembers={orgMembers} teamId="team_1" showAssistantLink />);
    const link = screen.getByRole("link", { name: /Threads/ });
    expect(link.getAttribute("href")).toBe("/chat?workspace=team_1");
  });
});


describe("TeamsPanel selected workspace", () => {
  function team(id: string, name: string, role: "admin" | "member" = "admin"): TeamSummary {
    return {
      id, name, callerRole: role, orgId: "org_1", origin: "local", externalId: null,
      createdAt: 1, memberCount: 2, defaultModel: null, defaultReasoning: null,
    };
  }

  beforeEach(() => {
    selectedTeamsOverride = [team("team_1", "Platform"), team("team_2", "Support")];
    selectedTeamsLoading = false;
    selectedTeamsError = null;
    orgRole = "member";
    origin = "local";
    deleteTeamMutate.mockClear();
    patchTeamMutate.mockClear();
  });
  afterEach(() => {
    selectedTeamsOverride = undefined;
    selectedTeamsLoading = false;
    selectedTeamsError = null;
  });

  it("shows only the selected team, expanded, without creation controls", () => {
    render(<TeamsPanel orgMembers={orgMembers} teamId="team_2" />);
    expect(screen.getByRole("button", { name: "Collapse Support" })).toBeTruthy();
    expect(screen.queryByText("Platform")).toBeNull();
    expect(screen.queryByLabelText("New team name")).toBeNull();
    fireEvent.focus(screen.getByRole("combobox", { name: "Default model" }));
    fireEvent.click(screen.getByText("Sonnet 4.5"));
    expect(patchTeamMutate).toHaveBeenCalledExactlyOnceWith({ id: "team_2", body: { defaultModel: "anthropic/claude-sonnet-4-5" } });
  });

  it("does not borrow admin permissions from another team", () => {
    selectedTeamsOverride = [team("team_1", "Platform"), team("team_2", "Support", "member")];
    render(<TeamsPanel orgMembers={orgMembers} teamId="team_2" />);
    expect(screen.getByText("Support")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Deletion requests" }).getAttribute("data-can-manage")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "Default model" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add member/ })).toBeNull();
  });

  it("retains org-admin controls for the selected team", () => {
    orgRole = "admin";
    selectedTeamsOverride = [team("team_2", "Support", "member")];
    render(<TeamsPanel orgMembers={orgMembers} teamId="team_2" />);
    expect(screen.getByRole("button", { name: "Support actions" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Default model" })).toBeTruthy();
  });

  it("does not fall back to another team when the selected team is unavailable", () => {
    render(<TeamsPanel orgMembers={orgMembers} teamId="missing" />);
    expect(screen.getByText(/This team is unavailable/)).toBeTruthy();
    expect(screen.queryByText("Platform")).toBeNull();
    expect(screen.queryByText("Support")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Default model" })).toBeNull();
  });

  it("hides cached mutation controls while loading or after a query error", () => {
    selectedTeamsLoading = true;
    const view = render(<TeamsPanel orgMembers={orgMembers} teamId="team_1" />);
    expect(screen.queryByRole("button", { name: "Platform actions" })).toBeNull();
    selectedTeamsLoading = false;
    selectedTeamsError = new Error("forbidden");
    view.rerender(<TeamsPanel orgMembers={orgMembers} teamId="team_1" />);
    expect(screen.getByText(/Failed to load teams/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Platform actions" })).toBeNull();
  });

  it("discards a pending deletion dialog when the selected workspace changes", async () => {
    const user = userEvent.setup();
    const view = render(<TeamsPanel key="team_1" orgMembers={orgMembers} teamId="team_1" />);
    await user.click(screen.getByRole("button", { name: "Platform actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete team" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    view.rerender(<TeamsPanel key="team_2" orgMembers={orgMembers} teamId="team_2" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(deleteTeamMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Collapse Support" })).toBeTruthy();
  });
});

vi.mock("~/api/onepassword", () => ({
  useTeamOnePasswordStatus: () => ({ data: { tokenConnected: false }, isPending: false, isError: false, isSuccess: true }),
  useTeamOnePasswordToken: () => ({ mutate: vi.fn(), isPending: false, reset: vi.fn() }),
}));
