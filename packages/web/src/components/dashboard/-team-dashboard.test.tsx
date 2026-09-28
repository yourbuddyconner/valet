// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TeamDashboard } from "./team-dashboard";
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("~/api/settings", () => ({ useTeams: () => ({ data: { teams: [{ id: "team-1", name: "Engineering", memberCount: 3 }] }, error: null }) }));
vi.mock("~/api/usage", () => ({ useUsageBreakdown: () => ({ data: undefined, error: null }) }));
vi.mock("~/api/memory", () => ({ useMemoryTree: () => ({ data: undefined, error: null }) }));
vi.mock("~/components/assistant/memory-card", () => ({ memoryStats: () => ({ files: 0, notes: 0, journalDays: 0, pinned: 0 }) }));
vi.mock("~/components/events/team-slack-setup", () => ({ TeamSlackSetupCard: ({ teamId }: { teamId: string }) => <div data-testid="team-setup">{teamId}</div> }));
vi.mock("./workspace-catch-up", () => ({ WorkspaceCatchUp: ({ owner }: { owner: { ownerId: string } }) => <div data-testid="catch-up" data-owner={owner.ownerId} /> }));
it("shows catch-up for the selected team above secondary cards", () => {
  const view = render(<TeamDashboard teamId="team-1" />);
  expect(screen.getByRole("heading", { name: "Engineering" })).toBeTruthy();
  expect(screen.getByTestId("catch-up").getAttribute("data-owner")).toBe("team-1");
  expect(screen.getByTestId("team-setup").textContent).toBe("team-1");
  expect(screen.getByRole("heading", { name: "Memory" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Activity" })).toBeNull();
  view.rerender(<TeamDashboard teamId="team-2" />);
  expect(screen.getByTestId("catch-up").getAttribute("data-owner")).toBe("team-2");
});
