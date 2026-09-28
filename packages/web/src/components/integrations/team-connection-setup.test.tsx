// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: { plugins: [{ services: [{ service: "linear", type: "oauth2", configKeys: ["accessToken"], connect: "oauth", connected: false, actions: [] }] }] } }),
  useCredentials: () => ({ data: { credentials: [] } }),
  useConnectCredential: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("~/api/repos", () => ({ useGithubOrgStatus: () => ({ data: undefined }) }));
vi.mock("~/api/settings", () => ({ useOrg: () => ({ data: { features: { organizations: true }, callerRole: "admin" } }) }));
vi.mock("~/api/workflows", () => ({ useTriggerCatalog: () => ({ data: { catalog: [{ service: "linear", readiness: { ready: false } }] } }) }));
import { TeamConnectionSetup } from "./team-connection-setup";
it("keeps native organization setup separate from explicit team MCP authorization", () => {
  render(<TeamConnectionSetup teamId="team" canManage orgAdmin />);
  expect(screen.getByRole("link", { name: "Connect Linear" }).getAttribute("href")).toBe("/settings/organization/linear");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Optional MCP tools").closest("details")!.open).toBe(false);
  screen.getByText("Optional MCP tools").closest("details")!.open = true;
  fireEvent.click(screen.getByRole("button", { name: "Connect via MCP" }));
  expect(screen.getByRole("dialog").textContent).toContain("Connect Linear via MCP to this team");
});
