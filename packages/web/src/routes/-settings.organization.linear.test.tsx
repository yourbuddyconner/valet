// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { GetLinearConnectionResponse } from "@valet/api/wire";
let data: GetLinearConnectionResponse;
let error = false;
const connect = vi.fn();
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config }));
vi.mock("~/api/linear", () => ({
  useLinearConnection: () => ({ data, isPending: false, isError: error, refetch: vi.fn() }),
  useConnectLinear: () => ({ mutate: connect, isPending: false, error: null }),
  useDisconnectLinear: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));
import { OrganizationLinearPage } from "./settings.organization.linear";
beforeEach(() => { error = false; connect.mockClear(); data = { configured: true, connected: false, webhookConfigured: false, ready: false }; });
it("offers the existing organization OAuth setup separately from personal tools", () => {
  render(<OrganizationLinearPage />);
  expect(screen.getByText(/Personal Linear connections provide tool access only/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connect events" }));
  expect(connect).toHaveBeenCalledOnce();
});
it("explains missing deployment configuration without offering a broken connection", () => {
  data.configured = false;
  render(<OrganizationLinearPage />);
  expect(screen.getByText(/Ask the deployment administrator/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connect events" }).hasAttribute("disabled")).toBe(true);
});
it("offers repair for an incomplete webhook and does not show stale setup after failure", () => {
  data = { ...data, connected: true, workspaceName: "Turnkey" };
  const view = render(<OrganizationLinearPage />);
  expect(screen.getByText("Events not connected")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reconnect events" })).toBeTruthy();
  error = true; view.rerender(<OrganizationLinearPage />);
  expect(screen.queryByRole("button", { name: "Reconnect events" })).toBeNull();
  expect(screen.getByText(/Could not load Linear setup/)).toBeTruthy();
});
