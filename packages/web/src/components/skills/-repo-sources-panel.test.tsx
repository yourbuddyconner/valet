// @vitest-environment jsdom
/**
 * The tracked-repository panel, which lives above the grid on `/skills` and,
 * pinned to the org, on `/settings/organization/library`. Mocks
 * `~/api/skill-sources` the same way the route suites mock their api modules:
 * this cares that the panel renders sync state, calls the right mutation, and
 * asks the server the right question, not that TanStack Query works.
 *
 * A team row's `OwnerBadge` links to that team's assistant and carries a
 * tooltip, so the panel needs a router stub (as the route suites use) and a
 * tooltip provider (as `session-header.test.tsx` uses).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListSkillSourcesResponse, SkillSourceSummary, ListTeamsResponse } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

function source(over: Partial<SkillSourceSummary> = {}): SkillSourceSummary {
  return {
    id: "skillsrc_1",
    repo: "tkhq/skills",
    ref: "",
    subpath: "",
    ownerType: "user",
    ownerId: "u1",
    kinds: ["skills"],
    enabled: true,
    status: "ok",
    skillCount: 3,
    lastSyncedAt: Date.now() - 60_000,
    lastSha: "abc123",
    lastMessage: null,
    ...over,
  };
}

let currentData: ListSkillSourcesResponse = { sources: [], nextCursor: null };
let currentState = { isLoading: false, error: null as Error | null };
const add = vi.fn();
const sync = vi.fn();
const remove = vi.fn();
/** What the panel asked the server for. The owner pin and the cursor are the
 * whole reason a page shows what it shows. */
const listQuery = vi.fn();
let addState = { isPending: false, error: null as Error | null };
let syncState = { isPending: false, error: null as Error | null, data: undefined as { excluded: number; discovered: number } | undefined };
let removeState = { isPending: false, error: null as Error | null };
let teamsData: ListTeamsResponse = { teams: [{ id: "team_1", orgId: "org_1", name: "Platform", origin: "local", externalId: null, defaultModel: null, createdAt: 1, memberCount: 2, callerRole: "member" as const }] };
let orgCallerRole: "admin" | "member" = "admin";

vi.mock("~/api/skill-sources", () => ({
  useSkillSources: (query: unknown) => {
    listQuery(query);
    return { data: currentData, ...currentState };
  },
  useAddSkillSource: () => ({ mutate: add, ...addState }),
  useSyncSkillSource: () => ({ mutate: sync, ...syncState }),
  useRemoveSkillSource: () => ({ mutate: remove, ...removeState }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  // The workspace scope reads `?assistant=` so an open assistant can override
  // the stored workspace. This panel is never rendered with one.
  useSearch: () => ({}),
}));

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({
    data: { features: { organizations: true }, callerRole: orgCallerRole },
    isLoading: false,
    error: null,
  }),
}));

// The badge links by assistant id, so it reads the assistants list to find
// the team's default one.

import { RepoSourcesPanel, type SourcesOwner } from "./repo-sources-panel";
import { PERSONAL, WorkspaceScopeProvider, useWorkspaceScope } from "~/lib/workspace-scope";

const onCursorsChange = vi.fn();

function SwitchWorkspace() {
  const scope = useWorkspaceScope();
  return <button onClick={() => scope.setKey(scope.teamId ? PERSONAL : "team_1")}>Switch workspace</button>;
}


/** `workspace` selects the workspace the panel is being read in — the same
 * thing the nav's switcher sets. It is seeded through localStorage because
 * that is where the real scope lives, so these cases exercise the actual
 * persistence rather than a value handed straight to the component. */
function renderPanel(
  workspace = PERSONAL,
  props: { owner?: SourcesOwner; readOnly?: boolean; cursors?: string[] } = {},
) {
  window.localStorage.setItem("valet:workspace", workspace);
  return render(
    <TooltipProvider>
      <WorkspaceScopeProvider>
        <SwitchWorkspace />
        <RepoSourcesPanel
          {...(props.owner === undefined ? {} : { owner: props.owner })}
          {...(props.readOnly === undefined ? {} : { readOnly: props.readOnly })}
          cursors={props.cursors ?? []}
          onCursorsChange={onCursorsChange}
        />
      </WorkspaceScopeProvider>
    </TooltipProvider>,
  );
}

describe("RepoSourcesPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    currentData = { sources: [], nextCursor: null };
    currentState = { isLoading: false, error: null };
    addState = { isPending: false, error: null };
    syncState = { isPending: false, error: null, data: undefined };
    removeState = { isPending: false, error: null };
    add.mockReset();
    sync.mockReset();
    remove.mockReset();
    listQuery.mockReset();
    onCursorsChange.mockReset();
    orgCallerRole = "admin";
    teamsData = {
      teams: [{ id: "team_1", orgId: "org_1", name: "Platform", origin: "local", externalId: null, defaultModel: null, createdAt: 1, memberCount: 2, callerRole: "member" }],
    };
  });

  it("says a public repository needs no GitHub connection, and names the one used for a private one", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    expect(screen.getByText(/needs no GitHub connection/i)).toBeTruthy();
    expect(screen.getByText(/your connected GitHub account/i)).toBeTruthy();
    // The claim this change removes: sync reads private repositories now.
    expect(screen.queryByText(/public repositories only/i)).toBeNull();
  });

  it("points personal and team tracking at Organization Library for org repositories", () => {
    renderPanel();

    const link = screen.getByText("Organization Library").closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("to")).toBe("/settings/organization/library");
    expect(screen.queryByText(/Any member can press Sync/)).toBeNull();
  });

  it("names the GitHub App and the admin gate on the org panel, without opening Import", () => {
    renderPanel(PERSONAL, { owner: { type: "org", id: "org1" } });

    expect(screen.getByText(/GitHub App installed for this organization/i)).toBeTruthy();
    expect(screen.getByText(/Only an org admin can add, remove, or sync a repository/)).toBeTruthy();
    expect(screen.queryByText(/your connected GitHub account/i)).toBeNull();
  });

  it("does not link a member to Organization Library", () => {
    orgCallerRole = "member";
    renderPanel();

    expect(screen.queryByRole("link", { name: "Organization Library" })).toBeNull();
    expect(screen.getByText(/tracked by an org admin/)).toBeTruthy();
  });

  it("imports what was typed into the box", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "https://github.com/tkhq/skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));

    expect(add).toHaveBeenCalledWith({
      repo: "https://github.com/tkhq/skills",
      kinds: ["skills"],
    });
  });

  it("files the import under the workspace being read, with no second question", () => {
    // There was an Owner select in this form. It asked again what the nav's
    // workspace switcher had already answered, and the two could disagree —
    // the panel could list one workspace's repositories while the form filed
    // a new one under another.
    renderPanel("team_1");
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "tkhq/skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));

    expect(add).toHaveBeenCalledWith({
      repo: "tkhq/skills",
      teamId: "team_1",
      kinds: ["skills"],
    });
    expect(screen.queryByLabelText("Owner")).toBeNull();
  });

  it("sends no teamId in your own workspace", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "tkhq/skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));

    expect(add).toHaveBeenCalledWith({ repo: "tkhq/skills", kinds: ["skills"] });
  });

  it("allows an org admin who is a team member to import privileged kinds", () => {
    renderPanel("team_1");
    fireEvent.click(screen.getByRole("button", { name: "Import from GitHub" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "workflows" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "templates" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Repository" }), { target: { value: "tkhq/automation" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(add).toHaveBeenCalledWith({ repo: "tkhq/automation", teamId: "team_1", kinds: ["skills", "workflows", "templates"] });
  });

  it("clears privileged selections when switching from a team to personal scope", () => {
    renderPanel("team_1");
    fireEvent.click(screen.getByRole("button", { name: "Import from GitHub" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "workflows" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
    expect(screen.getByRole("checkbox", { name: "workflows" })).toMatchObject({ checked: false, disabled: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Repository" }), { target: { value: "tkhq/automation" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(add).toHaveBeenCalledWith({ repo: "tkhq/automation", kinds: ["skills"] });
  });

  it("clears privileged selections when admin permission is revoked", () => {
    const view = renderPanel("team_1");
    fireEvent.click(screen.getByRole("button", { name: "Import from GitHub" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "workflows" }));
    orgCallerRole = "member";
    view.rerender(<TooltipProvider><WorkspaceScopeProvider><SwitchWorkspace /><RepoSourcesPanel cursors={[]} onCursorsChange={onCursorsChange} /></WorkspaceScopeProvider></TooltipProvider>);
    expect(screen.getByRole("checkbox", { name: "workflows" })).toMatchObject({ checked: false, disabled: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Repository" }), { target: { value: "tkhq/automation" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(add).toHaveBeenCalledWith({ repo: "tkhq/automation", teamId: "team_1", kinds: ["skills"] });
  });

  it("lets a team admin tick workflows and sends the kinds", () => {
    teamsData = {
      teams: [{ id: "team_1", orgId: "org_1", name: "Platform", origin: "local", externalId: null, defaultModel: null, createdAt: 1, memberCount: 2, callerRole: "admin" }],
    };
    renderPanel("team_1");
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: "workflows" }));
    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "tkhq/automation" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));
    expect(add).toHaveBeenCalledWith({
      repo: "tkhq/automation",
      teamId: "team_1",
      kinds: ["skills", "workflows"],
    });
  });

  it("disables workflows and templates for a personal source, with the reason", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    expect((screen.getByRole("checkbox", { name: "workflows" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "templates" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "memories" }) as HTMLInputElement).disabled).toBe(false);
    expect(
      screen.getByText(/personal source cannot collect workflows or templates/i),
    ).toBeTruthy();
  });

  it("shows the owning team's name on a team-tracked repository", () => {
    currentData = { sources: [source({ ownerType: "team", ownerId: "team_1" })], nextCursor: null };
    renderPanel();

    expect(screen.getByText("Platform")).toBeTruthy();
  });

  it("shows no ownership badge on a personal repository", () => {
    currentData = { sources: [source({ ownerType: "user", ownerId: "u1" })], nextCursor: null };
    renderPanel();

    expect(screen.queryByText("Platform")).toBeNull();
  });

  it("shows what the server said about a repository it refused", () => {
    addState = { isPending: false, error: new Error("Valet reads GitHub repositories only") };
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    expect(screen.getByText(/Valet reads GitHub repositories only/)).toBeTruthy();
  });

  it("lists a tracked repository with its skill count and sync time", () => {
    currentData = { sources: [source()], nextCursor: null };
    renderPanel();

    expect(screen.getByText("tkhq/skills")).toBeTruthy();
    expect(screen.getByText(/3 skills/)).toBeTruthy();
    expect(screen.getByText(/ago/)).toBeTruthy();
  });

  it("names the ref and the subdirectory when a source pins them", () => {
    currentData = { sources: [source({ ref: "main", subpath: "agent/skills" })], nextCursor: null };
    renderPanel();

    expect(screen.getByText(/main/)).toBeTruthy();
    expect(screen.getByText(/agent\/skills/)).toBeTruthy();
  });

  it("shows the server error when an org Sync fails", () => {
    syncState = {
      isPending: false,
      error: new Error(
        "Install the GitHub App for this organization, or add the repository to the App installation, then sync again.",
      ),
      data: undefined,
    };
    currentData = {
      sources: [source({ ownerType: "org", ownerId: "org1" })],
      nextCursor: null,
    };
    renderPanel(PERSONAL, { owner: { type: "org", id: "org1" } });

    expect(screen.getByText(/Install the GitHub App for this organization/)).toBeTruthy();
  });

  it("shows the server error when Remove fails", () => {
    removeState = {
      isPending: false,
      error: new Error("Ask an org admin to remove this repository, then retry."),
    };
    currentData = { sources: [source()], nextCursor: null };
    renderPanel();

    expect(screen.getByText(/Ask an org admin to remove this repository/)).toBeTruthy();
  });

  it("shows the message from a failed sync", () => {
    currentData = {
      sources: [source({ status: "error", lastMessage: "tkhq/x was not found on GitHub." })],
      nextCursor: null,
    };
    renderPanel();

    expect(screen.getByText(/was not found on GitHub/)).toBeTruthy();
  });

  it("shows the skipped skills from a sync that warned", () => {
    currentData = {
      sources: [source({ status: "warning", lastMessage: "broken: name is required." })],
      nextCursor: null,
    };
    renderPanel();

    expect(screen.getByText(/broken: name is required/)).toBeTruthy();
  });

  it("syncs and removes the source the buttons belong to", () => {
    currentData = { sources: [source()], nextCursor: null };
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));
    expect(sync).toHaveBeenCalledWith("skillsrc_1");

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(remove).toHaveBeenCalledWith("skillsrc_1");
  });

  it("says a source has never synced", () => {
    currentData = { sources: [source({ status: "pending", lastSyncedAt: null, skillCount: 0 })], nextCursor: null };
    renderPanel();

    expect(screen.getByText(/never synced/i)).toBeTruthy();
  });

  it("asks the server to drop org rows when no owner is pinned", () => {
    renderPanel();

    // `/skills` tracks personal and team repositories. Org rows live on
    // Organization · Library, so this listing must not mix them in.
    expect(listQuery).toHaveBeenCalledWith({ excludeOrg: true });
  });

  it("asks the server for the pinned owner, and files a new source there", () => {
    renderPanel(PERSONAL, { owner: { type: "org", id: "org_1" } });

    // Which rows an org panel shows is the server's answer, not a filter over
    // a page: an org row on page two would vanish from a client-side filter.
    expect(listQuery).toHaveBeenCalledWith({ ownerType: "org", ownerId: "org_1" });

    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "tkhq/org-skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));
    expect(add).toHaveBeenCalledWith({
      repo: "tkhq/org-skills",
      ownerType: "org",
      kinds: ["skills"],
    });
  });

  it("hides Import, Sync, and Remove from a read-only reader", () => {
    currentData = { sources: [source()], nextCursor: null };
    renderPanel(PERSONAL, { owner: { type: "org", id: "org_1" }, readOnly: true });

    expect(screen.queryByRole("button", { name: /import from github/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^sync$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
    // The rows themselves still read.
    expect(screen.getByText("tkhq/skills")).toBeTruthy();
  });

  it("hides Sync and Remove on an org row from a member", () => {
    orgCallerRole = "member";
    currentData = {
      sources: [source({ ownerType: "org", ownerId: "org_1" })],
      nextCursor: null,
    };
    renderPanel();

    expect(screen.queryByRole("button", { name: /^sync$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
  });

  it("keeps Sync and Remove on a personal row for a member", () => {
    orgCallerRole = "member";
    currentData = { sources: [source()], nextCursor: null };
    renderPanel();

    expect(screen.getByRole("button", { name: /^sync$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeTruthy();
  });

  it("keeps Remove on an org row for an admin", () => {
    currentData = {
      sources: [source({ ownerType: "org", ownerId: "org_1" })],
      nextCursor: null,
    };
    renderPanel();

    expect(screen.getByRole("button", { name: /^remove$/i })).toBeTruthy();
  });

  it("reads the page its cursor stack names, and reports the next one up", () => {
    currentData = { sources: [source()], nextCursor: "cursor_2" };
    renderPanel(PERSONAL, { cursors: ["cursor_1"] });

    expect(listQuery).toHaveBeenCalledWith({ excludeOrg: true, cursor: "cursor_1" });
    expect(screen.getByText("Page 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onCursorsChange).toHaveBeenCalledWith(["cursor_1", "cursor_2"]);

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onCursorsChange).toHaveBeenCalledWith([]);
  });

  it("shows no pager on a single page", () => {
    currentData = { sources: [source()], nextCursor: null };
    renderPanel();

    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
  });
});
