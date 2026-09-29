// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TeamOnePasswordToken } from "./team-onepassword-token";
import { api } from "~/api/client";

vi.mock("~/api/client", () => ({ api: { getTeamOnePasswordStatus: vi.fn(), putCredential: vi.fn(), deleteCredential: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function view(teamId = "a", canMutate = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const content = (id: string) => <QueryClientProvider client={qc}>
    <TeamOnePasswordToken key={id} teamId={id} teamName={id} canMutate={canMutate} />
  </QueryClientProvider>;
  const result = render(content(teamId));
  return { ...result, switchTeam: (id: string) => result.rerender(content(id)), qc };
}

describe("team 1Password connection", () => {
  it("shows loading and a retryable status error", async () => {
    vi.mocked(api.getTeamOnePasswordStatus).mockRejectedValue(new Error("offline"));
    view();
    expect(screen.getByText("Loading 1Password connection…")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect token" }).hasAttribute("disabled")).toBe(true);
  });

  it("connects without reference preferences and clears the submitted draft", async () => {
    vi.mocked(api.getTeamOnePasswordStatus).mockResolvedValue({ tokenConnected: false });
    vi.mocked(api.putCredential).mockImplementation(async () => {
      vi.mocked(api.getTeamOnePasswordStatus).mockResolvedValue({ tokenConnected: true });
      return { ok: true };
    });
    view();
    await screen.findByText("No team token connected. Team runtimes use the organization token when available.");
    const input = screen.getByLabelText("1Password service account token for a");
    fireEvent.change(input, { target: { value: "fake-team-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect token" }));
    expect(await screen.findByText("Team token connected.")).toBeTruthy();
    expect(api.putCredential).toHaveBeenCalledWith("onepassword", { type: "service_account", apiKey: "fake-team-token", scope: "team", teamId: "a" });
    expect(input.getAttribute("value")).toBe("");
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
    expect(screen.queryByText("1Password references")).toBeNull();
  });

  it("clears drafts on team switch and only shows status to a member", async () => {
    vi.mocked(api.getTeamOnePasswordStatus).mockResolvedValue({ tokenConnected: false });
    const rendered = view();
    await screen.findByText("No team token connected. Team runtimes use the organization token when available.");
    fireEvent.change(screen.getByLabelText("1Password service account token for a"), { target: { value: "fake-draft" } });
    rendered.switchTeam("b");
    await waitFor(() => expect(api.getTeamOnePasswordStatus).toHaveBeenCalledWith("b"));
    expect(screen.getByLabelText("1Password service account token for b").getAttribute("value")).toBe("");
    cleanup();
    view("c", false);
    expect(await screen.findByText("No team token connected. Team runtimes use the organization token when available.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect token" })).toBeNull();
  });

  it("requires confirmation before disconnecting and reports a failed save", async () => {
    vi.mocked(api.getTeamOnePasswordStatus).mockResolvedValue({ tokenConnected: true });
    vi.mocked(api.putCredential).mockRejectedValue(new Error("synthetic failure"));
    vi.mocked(api.deleteCredential).mockResolvedValue({ ok: true });
    view();
    await screen.findByText("Team token connected.");
    fireEvent.change(screen.getByLabelText("1Password service account token for a"), { target: { value: "fake-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    expect(await screen.findByText("Could not save the connection. Check your team access and try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(api.deleteCredential).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: "Disconnect" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.deleteCredential).toHaveBeenCalledWith("onepassword", { scope: "team", teamId: "a" }));
  });
});
