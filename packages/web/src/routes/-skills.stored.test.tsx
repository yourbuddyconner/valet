// @vitest-environment jsdom
/**
 * Stored skills on the Skills tab: what they add to the catalog page (an
 * origin badge, a shadow warning, a link to the row-id page), and the page
 * that reads and writes one.
 *
 * `SkillDoc` is rendered directly rather than through its two routes,
 * because it takes navigation as callbacks — the same reason `memory-doc`
 * does. Mocks `~/api/skills` the way `-skills.index.test.tsx` does, so the
 * assertions stay on the rendering, not on TanStack Query.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { ListSkillsResponse, ListTeamsResponse, SkillResponse } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

const data: ListSkillsResponse = {
  skills: [
    {
      name: "github",
      description: "How to use the GitHub tools.",
      origin: "plugin",
      plugin: "github",
      takesArgs: false,
    },
    {
      name: "deploy",
      description: "How to deploy the service.",
      origin: "local",
      id: "skill_1",
      ownerType: "user",
      ownerId: "u1",
      shadowed: false,
      takesArgs: false,
      updatedAt: 1_700_000_000_000,
    },
    {
      name: "github",
      description: "My own GitHub notes, kept out by the plugin skill.",
      origin: "local",
      id: "skill_2",
      ownerType: "user",
      ownerId: "u1",
      shadowed: true,
      takesArgs: false,
      updatedAt: 1_700_000_000_000,
    },
  ],
  nextCursor: null,
};

const stored: SkillResponse = {
  name: "deploy",
  description: "How to deploy the service.",
  origin: "local",
  id: "skill_1",
  ownerType: "user",
  ownerId: "u1",
  shadowed: false,
  takesArgs: false,
  updatedAt: 1_700_000_000_000,
  content: "Ship the service from main.\n",
  editable: true,
};

let teamsData: ListTeamsResponse = { teams: [] };

let currentData: ListSkillsResponse = data;
let currentState = { isLoading: false, error: null as Error | null };
let currentStored: SkillResponse = stored;

const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  createFileRoute: () => (config: object) => config,
  // The page keeps its filters and both cursor stacks in the search params.
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));

vi.mock("~/api/skills", () => ({
  useSkills: () => ({ data: currentData, ...currentState }),
  useStoredSkill: () => ({ data: currentStored, isLoading: false, error: null }),
  useCreateSkill: () => ({ mutate: create, isPending: false, error: null }),
  useUpdateSkill: () => ({ mutate: update, isPending: false, error: null }),
  useDeleteSkill: () => ({ mutate: remove, isPending: false, error: null }),
}));

vi.mock("~/api/settings", () => ({
  // `useListOwner` reads the caller's own id: the workspace switcher
  // holds a routing key, not a principal.
  useMe: () => ({ data: { id: "u-1" }, isLoading: false, error: null }),
  // `teamsData` is a let, so a test can give the caller a team before it
  // renders. `useOrg` is read by the editor to decide whether the org scope
  // is open to this caller — a member here, which is the common case.
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  // `features` present because the header's `WorkspaceClause` reads it;
  // organizations ON so the team fixtures stay eligible.
  useOrg: () => ({
    data: { callerRole: "member", features: { organizations: true } },
    isLoading: false,
    error: null,
  }),
}));

// The badge links by assistant id, so it reads the assistants list to find
// the team's default one.

// The repositories panel has its own suite; here it only has to render.
vi.mock("~/api/skill-sources", () => ({
  useSkillSources: () => ({ data: { sources: [], nextCursor: null }, isLoading: false, error: null }),
  useAddSkillSource: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useSyncSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { SkillsIndexPage } from "./skills.index";
import { SkillDoc } from "~/components/skills/skill-doc";

describe("SkillsIndexPage with stored skills", () => {
  beforeEach(() => {
    currentData = data;
    currentState = { isLoading: false, error: null };
    teamsData = { teams: [] };
  });

  it("badges each card with its scope", () => {
    const { container } = render(<SkillsIndexPage />);
    // Query inside the grid so the scope-filter dropdown's <option>s do not
    // count. One plugin skill, two personal stored skills.
    const grid = container.querySelector(".grid");
    const badgeText = (label: string) =>
      Array.from(grid?.querySelectorAll("span") ?? []).filter((el) => el.textContent === label);
    expect(badgeText("Plugin").length).toBe(1);
    expect(badgeText("Personal").length).toBe(2);
  });

  it("says why a shadowed skill never reaches a session, and how to fix it", () => {
    render(<SkillsIndexPage />);
    expect(screen.getByText(/Shadowed by another skill of the same name/)).toBeTruthy();
    expect(screen.getByText(/Rename this one/)).toBeTruthy();
  });

  it("links a stored skill to its row-id page, not to the name route", () => {
    const { container } = render(<SkillsIndexPage />);
    // The card's link covers the card instead of wrapping it — the owner
    // badge in the title row is a link of its own — so it is addressed by
    // the name it carries for a reader, not through the title text.
    const link = container.querySelector('a[aria-label="Read Deploy"]');
    expect(link?.getAttribute("to")).toBe("/skills/stored/$skillId");
  });

  it("names the team that owns a skill, instead of the bare word Team", () => {
    teamsData = {
      teams: [
        {
          id: "team_1",
          orgId: "org_1",
          name: "Platform",
          origin: "local",
          externalId: null,
          createdAt: 1,
          memberCount: 2,
          callerRole: "member", defaultModel: null,
        },
      ],
    };
    currentData = {
      skills: [
        {
          name: "release",
          description: "How the team ships.",
          origin: "local",
          id: "skill_3",
          ownerType: "team",
          ownerId: "team_1",
          shadowed: false,
          takesArgs: false,
          updatedAt: 1_700_000_000_000,
        },
      ],
      nextCursor: null,
    };
    const { container } = render(
      <TooltipProvider>
        <SkillsIndexPage />
      </TooltipProvider>,
    );

    expect(screen.getByText("Platform")).toBeTruthy();
    // Counted inside the grid, as in the scope-badge test above: the scope
    // filter over the grid carries a "Team" option, which is a filter value
    // and not a badge on a card.
    const grid = container.querySelector(".grid");
    const teamBadges = Array.from(grid?.querySelectorAll("span") ?? []).filter(
      (el) => el.textContent === "Team",
    );
    expect(teamBadges).toHaveLength(0);
  });

  it("points at both ways to write one when the catalog is empty", () => {
    currentData = { skills: [], nextCursor: null };
    render(<SkillsIndexPage />);
    expect(screen.getByText(/No skills yet/)).toBeTruthy();
    expect(screen.getByText("New skill")).toBeTruthy();
  });
});

describe("SkillDoc", () => {
  beforeEach(() => {
    currentStored = stored;
    create.mockClear();
    update.mockClear();
    remove.mockClear();
  });

  function open(props: Partial<Parameters<typeof SkillDoc>[0]> = {}) {
    return render(
      <SkillDoc skillId="skill_1" onCreated={() => undefined} onDeleted={() => undefined} {...props} />,
    );
  }

  it("reads the body of the skill the row id names", () => {
    open();
    expect(screen.getByRole("heading", { name: "Deploy", level: 1 })).toBeTruthy();
    expect(screen.getByText("Ship the service from main.")).toBeTruthy();
    // Reading, not editing: no field until Edit is pressed.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("repeats the shadow warning on the skill that is kept out", () => {
    currentStored = { ...stored, shadowed: true };
    open();
    expect(screen.getByText(/Shadowed by another skill of the same name/)).toBeTruthy();
  });

  it("opens the editor on the stored body and saves the edit", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const body = screen.getByRole("textbox", { name: "Playbook" });
    expect((body as HTMLTextAreaElement).value).toBe("Ship the service from main.\n");

    await user.type(screen.getByLabelText("Name"), "-now");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(update).toHaveBeenCalledTimes(1);
    const [args] = update.mock.calls[0] as [{ id: string; body: { name: string } }];
    expect(args.id).toBe("skill_1");
    expect(args.body.name).toBe("deploy-now");
  });

  it("deletes only after a confirm", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(remove).toHaveBeenCalledWith("skill_1", expect.anything());
  });

  it("offers no edit on a repo skill, and says where to change it", () => {
    currentStored = { ...stored, origin: "repo" };
    open();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText(/Edit it where it came from/)).toBeTruthy();
  });

  it("shows an org skill read-only to a member and names who manages it", () => {
    currentStored = { ...stored, ownerType: "org", editable: false };
    open();
    // The body still reads.
    expect(screen.getByText("Ship the service from main.")).toBeTruthy();
    // No write actions, and no editor field.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/Org skills are managed by org admins/)).toBeTruthy();
  });

  it("writes a new skill from an empty form", async () => {
    const user = userEvent.setup();
    open({ skillId: null });

    expect(screen.getByRole("heading", { name: "New skill", level: 1 })).toBeTruthy();
    await user.type(screen.getByLabelText("Name"), "deploy");
    await user.type(screen.getByLabelText("Description"), "How to deploy.");
    await user.type(screen.getByRole("textbox", { name: "Playbook" }), "Ship it.");
    await user.click(screen.getByRole("button", { name: "Create skill" }));

    expect(create).toHaveBeenCalledTimes(1);
    const [body] = create.mock.calls[0] as [{ name: string; description: string; content: string }];
    expect(body).toMatchObject({ name: "deploy", description: "How to deploy.", content: "Ship it." });
  });

  it("keeps a half-written skill unsaveable", () => {
    open({ skillId: null });
    expect(screen.getByRole("button", { name: "Create skill" }).hasAttribute("disabled")).toBe(true);
  });
});
