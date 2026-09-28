// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  Link, Outlet, RouterProvider, createMemoryHistory, createRootRoute,
  createRoute, createRouter,
} from "@tanstack/react-router";
import { SettingsLayout } from "./settings";

vi.mock("~/lib/workspace-scope", () => ({
  useWorkspaceScope: () => ({ teamId: "team_1", key: "team_1" }),
}));
vi.mock("~/api/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/settings")>(),
  useOrg: () => ({ data: { callerRole: "admin", features: { organizations: true } } }),
}));

describe("leaving team settings", () => {
  it.each(["/integrations", "/workflows", "/chat"])("allows primary navigation to %s", async (destination) => {
    const root = createRootRoute({ component: () => <><Link to={destination}>Leave settings</Link><Outlet /></> });
    const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsLayout });
    const team = createRoute({ getParentRoute: () => settings, path: "/team", component: () => <p>Team settings content</p> });
    const target = createRoute({ getParentRoute: () => root, path: destination, component: () => <p>Destination content</p> });
    const router = createRouter({
      routeTree: root.addChildren([settings.addChildren([team]), target]),
      history: createMemoryHistory({ initialEntries: ["/settings/team"] }),
      defaultPendingMinMs: 0,
    });
    render(<RouterProvider router={router} />);
    await screen.findByText("Team settings content");
    fireEvent.click(screen.getByRole("link", { name: "Leave settings" }));
    await screen.findByText("Destination content");
    await waitFor(() => expect(router.state.status).toBe("idle"));
    expect(router.state.location.pathname).toBe(destination);
    expect(screen.queryByText("Team settings content")).toBeNull();
  });
});
