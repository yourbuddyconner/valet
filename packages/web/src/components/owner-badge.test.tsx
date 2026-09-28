// @vitest-environment jsdom
/**
 * OwnerBadge: the one badge four lists used to render four ways. It says
 * nothing about a personal row, names the owning team on a team row, keeps a
 * neutral word when the team cannot be resolved, and links to that team's
 * assistant.
 *
 * Mocks `~/api/settings` for the teams list, and `@tanstack/react-router`
 * the way the route suites do — the real `Link` wants a router this suite
 * has no reason to mount. `search` is serialized onto the stub so a test can
 * read the query the badge would navigate with.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ListAssistantsResponse, ListTeamsResponse } from "@valet/api/wire";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "~/components/primitives";

let teamsData: ListTeamsResponse = { teams: [] };
/** The badge links by assistant id, so it needs the list that maps an owner
 * to one. A team with no listed assistant has nothing to link to. */
function teamAssistants(): ListAssistantsResponse {
  return {
    assistants: [
      {
        id: "asst_team_1",
        owner: { type: "team", id: "team_1" },
        sessionId: "assistant:asst_team_1",
        isDefault: true,
        createdAt: 1,
      },
    ],
  };
}
let assistantsData: ListAssistantsResponse = teamAssistants();

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
}));

vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({ data: assistantsData, isLoading: false, error: null }),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    ...rest
  }: {
    children: ReactNode;
    search?: unknown;
    [key: string]: unknown;
  }) => (
    <a data-search={JSON.stringify(search)} {...rest}>
      {children}
    </a>
  ),
}));

import { OwnerBadge } from "./owner-badge";

function team(over: Partial<ListTeamsResponse["teams"][number]> = {}) {
  return {
    id: "team_1",
    orgId: "org_1",
    name: "Design",
    origin: "local" as const,
    externalId: null,
    createdAt: 1,
    memberCount: 3,
    callerRole: "member" as const,
    defaultModel: null,
    ...over,
  };
}

function show(ownerType: "user" | "team" | "org", ownerId: string) {
  return render(
    <TooltipProvider>
      <OwnerBadge ownerType={ownerType} ownerId={ownerId} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  teamsData = { teams: [] };
  assistantsData = teamAssistants();
});

describe("OwnerBadge", () => {
  it("says nothing about a row the reader owns", () => {
    teamsData = { teams: [team()] };
    const { container } = show("user", "u1");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("");
  });

  // Org-owned rows exist (event subscriptions with an org orchestrator
  // target). This badge stays silent for one because it links to a team's
  // assistant; the subscriptions panel labels its own org rows.
  it("says nothing about an org-owned row either", () => {
    teamsData = { teams: [team()] };
    const { container } = show("org", "org_1");
    expect(container.textContent).toBe("");
  });

  it("names the owning team", () => {
    teamsData = { teams: [team({ id: "team_1", name: "Design" })] };
    show("team", "team_1");
    expect(screen.getByText("Design")).toBeTruthy();
  });

  it("keeps a neutral label when the team cannot be resolved", () => {
    // A team the caller cannot see, or an id whose team is gone. The row is
    // still team-owned, so the badge stays and says that much.
    teamsData = { teams: [team({ id: "team_other", name: "Design" })] };
    show("team", "team_gone");
    expect(screen.getByText("Team")).toBeTruthy();
    expect(screen.queryByText("Design")).toBeNull();
  });

  it("links to the owning team's default assistant", () => {
    // A team owns several assistants now, so an owner-shaped link has to
    // pick one: the default, which is what every machine-driven path
    // targets when nobody chose.
    teamsData = { teams: [team()] };
    const { container } = show("team", "team_1");

    const link = container.querySelector("a");
    expect(link?.getAttribute("to")).toBe("/chat");
    expect(JSON.parse(link?.getAttribute("data-search") ?? "null")).toEqual({
      workspace: "team_1",
    });
  });

  it("still names the owner when the team has no assistant to link to", () => {
    teamsData = { teams: [team()] };
    assistantsData = { assistants: [] };
    const { container } = show("team", "team_1");

    expect(screen.getByText("Design")).toBeTruthy();
    expect(container.querySelector("a")?.getAttribute("to")).toBe("/chat");
  });

  it("names the destination on hover", () => {
    teamsData = { teams: [team()] };
    const { container } = show("team", "team_1");

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    fireEvent.focus(link as HTMLAnchorElement);

    expect(screen.getAllByText("Open Design's threads").length).toBeGreaterThan(0);
  });
});
