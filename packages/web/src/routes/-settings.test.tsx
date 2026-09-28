// @vitest-environment jsdom
/**
 * Settings shell (split-settings design, Task 5): the rail's gate-aware
 * Organization group, the `/settings` → `/settings/profile` redirect, and
 * the org-route guard's two spec-verbatim empty states. `Link`/`redirect`
 * need router context — mocked the same way `-workflows.index.test.tsx`
 * mocks `@tanstack/react-router`, since these tests only care what the
 * shell renders/requests, not that the router itself resolves it.
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useOrgMock = vi.fn();
const pathnameMock = vi.fn<() => string>();

beforeEach(() => {
  pathnameMock.mockReturnValue("/settings/profile");
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useRouterState: () => pathnameMock(),
  createFileRoute: () => (config: unknown) => config,
  redirect: (opts: { to: string }) => ({ isRedirect: true as const, ...opts }),
}));

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => useOrgMock(),
  };
});

import { SettingsRail } from "~/components/settings/settings-rail";
import { redirectToProfile } from "./settings.index";
import { OrgRouteGuard } from "./settings.organization";

const YOU_LABELS = ["Profile", "Thread defaults", "Appearance", "Notifications"];
const ORG_LABELS = ["General", "Members", "Teams"];

function mockOrg(data: { organizations: boolean; callerRole: "admin" | "member" } | undefined, isLoading = false) {
  useOrgMock.mockReturnValue({
    data: data && {
      id: "org_1",
      name: "Acme",
      createdAt: 0,
      features: { organizations: data.organizations },
      callerRole: data.callerRole,
    },
    isLoading,
    isError: false,
    refetch: vi.fn(),
  });
}

/** A settled /api/org failure with nothing cached — the guard's error state. */
function mockOrgError() {
  useOrgMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch: vi.fn(),
  });
}

describe("SettingsRail", () => {
  it("always renders the four You items", () => {
    mockOrg({ organizations: false, callerRole: "member" });
    render(<SettingsRail />);
    for (const label of YOU_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("hides the Organization group when the gate is off", () => {
    mockOrg({ organizations: false, callerRole: "admin" });
    render(<SettingsRail />);
    for (const label of ORG_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("shows a gate-on member only the Teams item in the Organization group", () => {
    mockOrg({ organizations: true, callerRole: "member" });
    render(<SettingsRail />);
    expect(screen.getByText("Teams")).toBeTruthy();
    for (const label of ORG_LABELS.filter((l) => l !== "Teams")) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("shows NO Models item to a gate-on member — every section of that page is admin-only", () => {
    mockOrg({ organizations: true, callerRole: "member" });
    render(<SettingsRail />);
    expect(screen.queryByText("Models")).toBeNull();
  });

  it("shows the Organization group when the gate is on and the caller is admin", () => {
    mockOrg({ organizations: true, callerRole: "admin" });
    render(<SettingsRail />);
    for (const label of ORG_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("renders nothing for the Organization group before the org query resolves", () => {
    mockOrg(undefined, true);
    render(<SettingsRail />);
    for (const label of ORG_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("shows a You·Models item in single-user mode (org gate off)", () => {
    mockOrg({ organizations: false, callerRole: "admin" });
    render(<SettingsRail />);
    expect(screen.getByText("Models")).toBeTruthy();
  });

  it("does NOT duplicate Models under You when the Organization group is visible", () => {
    mockOrg({ organizations: true, callerRole: "admin" });
    render(<SettingsRail />);
    // Exactly one "Models" — the Organization group's.
    expect(screen.getAllByText("Models")).toHaveLength(1);
  });

  it("shows no Models item before the org query resolves (no flash)", () => {
    mockOrg(undefined, true);
    render(<SettingsRail />);
    expect(screen.queryByText("Models")).toBeNull();
  });
});

describe("/settings index redirect", () => {
  it("redirects to /settings/profile", () => {
    expect(() => redirectToProfile()).toThrow();
    try {
      redirectToProfile();
    } catch (thrown) {
      expect(thrown).toEqual({ isRedirect: true, to: "/settings/profile" });
    }
  });
});

describe("OrgRouteGuard", () => {
  it("renders nothing while the org query is loading", () => {
    mockOrg(undefined, true);
    const { container } = render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("shows the gate-off empty state verbatim", () => {
    mockOrg({ organizations: false, callerRole: "admin" });
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByText("Organizations aren't enabled")).toBeTruthy();
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("shows the member empty state verbatim when the gate is on but the caller isn't admin", () => {
    mockOrg({ organizations: true, callerRole: "member" });
    pathnameMock.mockReturnValue("/settings/organization/members");
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(
      screen.getByText("Organization settings are managed by your org admins"),
    ).toBeTruthy();
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("admits a gate-on member to the Teams page — any member can create and run teams", () => {
    mockOrg({ organizations: true, callerRole: "member" });
    pathnameMock.mockReturnValue("/settings/organization/teams");
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByTestId("org-content")).toBeTruthy();
  });

  it("admits a member on a trailing-slash Teams URL — the router matches it, so the guard must too", () => {
    mockOrg({ organizations: true, callerRole: "member" });
    pathnameMock.mockReturnValue("/settings/organization/teams/");
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByTestId("org-content")).toBeTruthy();
  });

  it("shows a retry state when the org query fails with nothing cached — never the gate-off message", () => {
    mockOrgError();
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByText("Failed to load organization settings.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Organizations aren't enabled")).toBeNull();
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("keeps the gate-off empty state on the Teams path too", () => {
    mockOrg({ organizations: false, callerRole: "member" });
    pathnameMock.mockReturnValue("/settings/organization/teams");
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByText("Organizations aren't enabled")).toBeTruthy();
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("renders children when the gate is on and the caller is admin", () => {
    mockOrg({ organizations: true, callerRole: "admin" });
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByTestId("org-content")).toBeTruthy();
  });
});
