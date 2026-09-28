// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ThreadsCard } from "./threads-card";
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock("~/api/workspace-runtime", () => ({ useWorkspaceRuntimeInfo: () => ({ data: { sessionId: "parent" } }) }));
vi.mock("~/api/queries", () => ({ useThreads: () => ({ data: { threads: [{ id: "old-thread", title: "Older running work", createdAt: 1 }] } }) }));
vi.mock("~/api/child-work", async original => ({ ...await original<typeof import("~/api/child-work")>(), useChildWork: () => ({ hasNextPage: true, data: { pages: [{ children: [], runningCount: 40, nextCursor: "more" }] } }) }));
it("shows the server total without calling threads missing from a bounded page idle", () => {
  render(<ThreadsCard />);
  expect(screen.getByText("40 running · View all work")).toBeTruthy();
  expect(screen.getByText("Older running work")).toBeTruthy();
  expect(screen.queryByLabelText("idle")).toBeNull();
});
