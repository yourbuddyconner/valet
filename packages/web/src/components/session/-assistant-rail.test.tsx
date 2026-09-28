// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AssistantRail } from "./assistant-rail";
let data: { sessionId: string } | undefined;
let error: Error | null = null;
const retry = vi.fn();
vi.mock("~/hooks/use-workspace-conversation", () => ({ useWorkspaceConversation: () => ({ data, error, refetch: retry }) }));
vi.mock("./thread-tree", () => ({
  ThreadTree: ({ sessionId }: { sessionId: string }) => <div data-testid="threads">{sessionId}</div>,
  ThreadTreeWaiting: () => <div>Opening threads</div>,
}));
beforeEach(() => { data = { sessionId: "team-session" }; error = null; });
it("shows workspace threads without profile or creation controls", () => {
  render(<AssistantRail />);
  expect(screen.getByTestId("threads").textContent).toBe("team-session");
  expect(screen.queryByRole("button", { name: /assistant/i })).toBeNull();
});
it("waits for the workspace session before fetching its threads", () => {
  data = undefined; render(<AssistantRail />);
  expect(screen.queryByTestId("threads")).toBeNull(); expect(screen.getByText("Opening threads")).toBeTruthy();
});
it("shows an actionable error without mounting another workspace", () => {
  data = undefined; error = new Error("not found"); render(<AssistantRail />);
  expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByTestId("threads")).toBeNull();
});
