// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { GetLinearConnectionResponse } from "@valet/api/wire";
let data: GetLinearConnectionResponse;
let error = false;
const connect = vi.fn();
const save = vi.fn();
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config }));
vi.mock("~/api/linear", () => ({
  useLinearConnection: () => ({ data, isPending: false, isError: error, refetch: vi.fn() }),
  useConnectLinear: () => ({ mutate: connect, isPending: false, error: null }),
  useSaveLinearApp: () => ({ mutate: save, isPending: false, error: null }),
  useDisconnectLinear: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));
import { OrganizationLinearPage } from "./settings.organization.linear";
beforeEach(() => { error = false; connect.mockClear(); save.mockClear(); data = { configured: true, connected: false, webhookConfigured: false, ready: false }; });
it("offers the existing organization OAuth setup separately from personal tools", () => {
  render(<OrganizationLinearPage />);
  expect(screen.getByText(/Personal tool connections remain separate/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
  expect(connect).toHaveBeenCalledOnce();
});
it("lets admins configure the app before connecting", () => {
  data.configured = false;
  render(<OrganizationLinearPage />);
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "client-id" } });
  fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "client-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save app credentials" }));
  expect(save).toHaveBeenCalledWith({ clientId: "client-id", clientSecret: "client-secret" }, expect.any(Object));
  expect(screen.getByRole("button", { name: "Connect Linear" }).hasAttribute("disabled")).toBe(true);
});
it("offers repair for an incomplete webhook and does not show stale setup after failure", () => {
  data = { ...data, connected: true, workspaceName: "Turnkey" };
  const view = render(<OrganizationLinearPage />);
  expect(screen.getByText("Not connected")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reconnect Linear" })).toBeTruthy();
  error = true; view.rerender(<OrganizationLinearPage />);
  expect(screen.queryByRole("button", { name: "Reconnect Linear" })).toBeNull();
  expect(screen.getByText(/Could not load Linear setup/)).toBeTruthy();
});

it("shows credential entry with deployment defaults and links to Linear app creation", () => {
  data.appSource = "deployment";
  data.redirectUri = "https://valet.example/api/org/linear/callback";
  render(<OrganizationLinearPage />);
  expect(screen.getByLabelText("Client ID")).toBeTruthy();
  expect(screen.getByLabelText("Client secret").getAttribute("type")).toBe("password");
  expect(screen.getByRole("link", { name: "Create app in Linear" }).getAttribute("href")).toBe("https://linear.app/settings/api/applications/new");
  expect(screen.getByLabelText("Redirect URI").getAttribute("value")).toBe(data.redirectUri);
});
it("requires saving edited credentials before connecting with defaults", () => {
  render(<OrganizationLinearPage />);
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "replacement" } });
  expect(screen.getByRole("button", { name: "Connect Linear" }).hasAttribute("disabled")).toBe(true);
});
