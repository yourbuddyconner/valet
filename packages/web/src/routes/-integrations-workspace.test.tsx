// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CredentialSummary, GetGithubOrgStatusResponse, ListCredentialsResponse, ListPluginsResponse, TeamSummary } from "@valet/api/wire";
import { api, ApiError } from "~/api/client";
import { qkIntegrations } from "~/api/integrations";
import { qkRepos } from "~/api/repos";
import { qkSettings } from "~/api/settings";

let teamId: string | undefined;
let realWorkspace = false;
const setKey = vi.fn();
vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return { ...original, useWorkspaceScope: () => realWorkspace ? original.useWorkspaceScope() : { teamId, setKey } };
});
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));

function team(id: string, name: string, callerRole: TeamSummary["callerRole"]): TeamSummary {
  return { id, name, callerRole, orgId: "org", origin: "local", externalId: null,
    createdAt: 1, memberCount: 2, defaultModel: null };
}
let teams: TeamSummary[];
let orgRole: "admin" | "member";
let teamsError: Error | null;
let teamsLoading: boolean;
let directoryError: Error | null;
vi.mock("~/api/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/settings")>(),
  useOrg: () => ({ data: { features: { organizations: true } } }),
  useTeams: () => ({ data: { teams }, isLoading: teamsLoading, error: teamsError }),
  useMe: () => ({ data: { orgRole, name: "My account", email: "me@example.com" }, isLoading: false, error: null }),
  useOrgDirectory: () => ({
    data: { users: [{ userId: "u1", name: "Alice" }] },
    isLoading: false, error: directoryError,
  }),
}));
vi.mock("~/api/queries", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/queries")>(),
  useIdentityLinks: () => ({ data: { links: [] }, isLoading: false, error: null }),
}));
vi.mock("~/api/repos", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/repos")>(),
  useConnectGithub: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { IntegrationsPage } from "./integrations";

const PERSONAL_PLUGINS: ListPluginsResponse = { plugins: [{
  name: "typefully", version: "1", actionCount: 0, dynamic: true,
  services: [{ service: "typefully", type: "api_key", configKeys: ["accessToken"],
    connected: false, connect: "manual", dynamic: true, actions: [] }],
}] };
const A: CredentialSummary = { service: "linear", type: "oauth2", connectedAt: "2026-09-10", delegatedFrom: "u1" };
const B: CredentialSummary = { service: "sentry", type: "api_key", connectedAt: "2026-09-10" };
const ORG_PLUGINS: ListPluginsResponse = { plugins: [{ name: "org-apps", version: "1", actionCount: 0, services: [
  { service: "slack", type: "bot_token", configKeys: ["accessToken"], connected: false, connect: "org", actions: [] },
  { service: "github", type: "oauth2", configKeys: ["accessToken"], connected: true, connect: "manual", actions: [] },
] }] };

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (realWorkspace) {
    // importOriginal can load the provider through the settings module cycle
    // before its hook overrides apply. Seed the real queries as well: missing
    // data means membership is unknown, not that the callback team was lost.
    client.setQueryData(qkSettings.teams(), { teams });
    client.setQueryData(qkSettings.org(), { features: { organizations: true } });
  }
  const page = () => <QueryClientProvider client={client}>{realWorkspace ? <WorkspaceScopeProvider><IntegrationsPage /></WorkspaceScopeProvider> : <IntegrationsPage />}</QueryClientProvider>;
  const view = render(page());
  return { client, switchTo: (id?: string) => { teamId = id; view.rerender(page()); } };
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/integrations");
  setKey.mockClear();
  teamId = undefined;
  realWorkspace = false;
  window.localStorage.clear();
  orgRole = "member";
  teams = [team("a", "Team A", "admin"), team("b", "Team B", "admin")];
  teamsError = null;
  teamsLoading = false;
  directoryError = null;
  vi.spyOn(api, "listPlugins").mockResolvedValue(PERSONAL_PLUGINS);
  vi.spyOn(api, "getGithubOrgStatus").mockResolvedValue({ configured: false, installationCount: 0, suspendedCount: 0 });
  vi.spyOn(api, "listCredentials").mockImplementation(async (scope, id) => {
    if (scope !== "team") throw new Error("Unexpected personal credential read");
    return { credentials: id === "a" ? [A] : [B] };
  });
  vi.spyOn(api, "deleteCredential").mockResolvedValue({ ok: true });
});

describe("Integrations workspace isolation", () => {
  it("switches Personal -> team A -> team B -> Personal without retaining forms or team dialogs", async () => {
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Typefully" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const token = screen.getByLabelText("API key");
    fireEvent.change(token, { target: { value: "personal-token-draft" } });

    view.switchTo("a");
    expect(screen.queryByDisplayValue("personal-token-draft")).toBeNull();
    expect(screen.queryByDisplayValue("personal-token-draft")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Shared by Alice")).toBeTruthy();
    expect(screen.getByText("Shared by members")).toBeTruthy();
    expect(screen.getByText(/Team actions use Alice’s account/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing Linear with Team A" }));

    view.switchTo("b");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Linear MCP")).toBeNull();
    expect(await screen.findByText("Sentry")).toBeTruthy();
    expect(screen.getByText("Stored on the team")).toBeTruthy();
    expect(api.listCredentials).toHaveBeenCalledWith("team", "a");
    expect(api.listCredentials).toHaveBeenCalledWith("team", "b");
    expect(api.listPlugins).toHaveBeenCalledWith("a");
    expect(api.listPlugins).toHaveBeenCalledWith("b");

    view.switchTo();
    expect(await screen.findByRole("button", { name: "Connect Typefully" })).toBeTruthy();
    expect(screen.queryByText("Sentry")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.deleteCredential).not.toHaveBeenCalled();
  });

  it("does not show cached personal or team A data while team B loads or fails", async () => {
    teamId = "a";
    const view = mount();
    await screen.findByText("Linear MCP");
    let rejectRead: (error: Error) => void = () => {};
    vi.mocked(api.listCredentials).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRead = reject; }));
    view.switchTo("b");
    expect(screen.getByText("Loading credentials…")).toBeTruthy();
    expect(screen.queryByText("Linear MCP")).toBeNull();
    await act(async () => rejectRead(new Error("Forbidden")));
    expect(await screen.findByText("Could not load credentials. Reload the page.")).toBeTruthy();
    // Credential-row controls name their service and their team, so this
    // matches every one of them and no other resource's. The team 1Password
    // token has its own query and its own failure state, so it is not part
    // of what a failed credential read must hide.
    expect(
      screen.queryByRole("button", { name: /(Disconnect|Stop sharing) .+ (from|with) / }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Share with a team" })).toBeNull();
  });

  it("keeps members read-only and explains empty teams", async () => {
    teamId = "a";
    teams = [team("a", "Team A", "member")];
    const view = mount();
    await screen.findByText("Shared by Alice");
    expect(screen.getByText("Only team or organization admins can remove team connections.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Disconnect|Stop sharing/ })).toBeNull();
    act(() => view.client.setQueryData<ListCredentialsResponse>(qkIntegrations.credentials("team", "a"), { credentials: [] }));
    expect(await screen.findByText(/No connections added to this team yet/)).toBeTruthy();
    // A plain member may not remove a team connection, but sharing one of
    // their OWN is the same write the personal page already allows, so the
    // team page offers it here rather than sending them elsewhere.
    expect(
      screen.getByRole("button", { name: "Share one of your connections with Team A" }),
    ).toBeTruthy();
  });

  // The generic create-only dialog cannot host a service-account token: the
  // team list skips reserved rows so a live token never reads as occupied,
  // and the team write upserts, so the dialog would replace it with no 409.
  it("keeps 1Password out of the connect picker and offers the team token control instead", async () => {
    teamId = "a";
    teams = [team("a", "Team A", "admin")];
    orgRole = "admin";
    mount();
    expect(await screen.findByRole("region", { name: "1Password for Team A" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect 1Password" })).toBeNull();
  });

  it("lets an org admin manage a team they are not on and reports delete errors", async () => {
    teamId = "b";
    teams = [team("b", "Team B", null)];
    orgRole = "admin";
    vi.mocked(api.deleteCredential).mockRejectedValue(new ApiError(404, "Access changed. Reload the page."));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Sentry from Team B" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Access changed. Reload the page.")).toBeTruthy();
    expect(api.deleteCredential).toHaveBeenCalledWith("sentry", { scope: "team", teamId: "b" });
  });

  it("reports team lookup failures without falling back to personal integrations", async () => {
    teamId = "a";
    teamsError = new Error("Unavailable");
    mount();
    expect(screen.getByText("Could not load team integrations. Reload the page to try again.")).toBeTruthy();
    expect(api.listCredentials).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Share with a team" })).toBeNull();
  });

  it("waits for teams and handles a missing team", () => {
    teamId = "a";
    teamsLoading = true;
    const view = mount();
    expect(screen.getByText("Loading team integrations…")).toBeTruthy();
    expect(api.listCredentials).not.toHaveBeenCalled();
    teamsLoading = false;
    teams = [];
    view.switchTo("a");
    expect(screen.getByText(/This team is unavailable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share with a team" })).toBeNull();
  });

  it("keeps credentials visible with IDs when member names fail", async () => {
    teamId = "a";
    directoryError = new Error("Unavailable");
    mount();
    expect(await screen.findByText("Shared by u1")).toBeTruthy();
    expect(screen.getByText(/Could not load member names/)).toBeTruthy();
  });

  it("hides stale credentials and an open dialog when a refetch loses access", async () => {
    teamId = "a";
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Stop sharing Linear with Team A" }));
    vi.mocked(api.listCredentials).mockRejectedValue(new Error("Forbidden"));
    await act(async () => { await view.client.invalidateQueries({ queryKey: qkIntegrations.credentials("team", "a") }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Linear MCP")).toBeNull();
    expect(screen.getByText("Could not load credentials. Reload the page.")).toBeTruthy();
  });
});


describe("Team account connection", () => {
  it("discards the open form after a failed credential read and does not reopen it on recovery", async () => {
    teamId = "a";
    const put = vi.spyOn(api, "putCredential").mockResolvedValue({ ok: true });
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Typefully" }));
    expect(screen.getByText("Paste a token for the account intended for this team. Everyone on this team can use its permissions.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Team account token"), { target: { value: "discarded-token" } });
    fireEvent.click(screen.getByRole("checkbox"));
    vi.mocked(api.listCredentials).mockRejectedValue(new Error("Forbidden"));
    await act(async () => { await view.client.invalidateQueries({ queryKey: qkIntegrations.credentials("team", "a") }); });
    expect(await screen.findByText("Could not check team connections. Reload the page.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect Typefully" }).hasAttribute("disabled")).toBe(true);
    expect(put).not.toHaveBeenCalled();
    vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [] });
    await act(async () => { await view.client.invalidateQueries({ queryKey: qkIntegrations.credentials("team", "a") }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Typefully" }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect Typefully" }));
    expect(screen.getByLabelText("Team account token")).toHaveProperty("value", "");
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
  });

  it.each(["slack", "github"])("explains that legacy %s removal cannot be undone through team setup", async (service) => {
    teamId = "a";
    vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [{ service, type: "oauth2", connectedAt: "2026-09-10" }] });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Disconnect .* from Team A/ }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/Team Integrations cannot recreate this connection/)).toBeTruthy();
    expect(dialog.getByText(/organization admin manages organization access in Organization settings/)).toBeTruthy();
    expect(dialog.queryByText(/again from Integrations/)).toBeNull();
    expect(screen.queryByText("Shared by members")).toBeNull();
    expect(api.deleteCredential).not.toHaveBeenCalled();
  });

  it("requires confirmation and writes only to the selected team's empty slot", async () => {
    teamId = "a";
    const put = vi.spyOn(api, "putCredential").mockResolvedValue({ ok: true });
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Typefully" }));
    fireEvent.change(screen.getByLabelText("Team account token"), { target: { value: "team-test-token" } });
    const submit = screen.getByRole("button", { name: "Connect team account" });
    fireEvent.click(submit);
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(submit);
    await waitFor(() => expect(put).toHaveBeenCalledWith("typefully", expect.objectContaining({ scope: "team", teamId: "a", createOnly: true, apiKey: "team-test-token" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Connect Typefully" }));
    fireEvent.change(screen.getByLabelText("Team account token"), { target: { value: "unsaved-token" } });
    view.switchTo("b");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByDisplayValue("unsaved-token")).toBeNull();
  });
  it("requires consent before continuing to team OAuth and never asks for a pasted token", async () => {
    teamId = "b";
    vi.mocked(api.listPlugins).mockResolvedValue({ plugins: [{ name: "linear", version: "1", actionCount: 0, dynamic: true,
      services: [{ service: "linear", type: "oauth2", configKeys: ["accessToken"], connected: false, connect: "oauth", dynamic: true, actions: [] }],
    }] });
    mount();
    fireEvent.click(await screen.findByText("Optional MCP tools"));
    fireEvent.click(screen.getByRole("button", { name: "Connect via MCP" }));
    const submit = screen.getByRole("button", { name: "Continue to Linear" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByLabelText("Team account token")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  it("returns OAuth feedback to its team without forcing later workspace switches back", async () => {
    window.history.replaceState(null, "", "/integrations?teamId=a&connected=linear");
    teamId = "a";
    const view = mount();
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Connected Linear via MCP.");
    expect(setKey).toHaveBeenCalledWith("a");
    setKey.mockClear();
    view.switchTo("b");
    await screen.findByText("Sentry");
    expect(setKey).not.toHaveBeenCalled();
    expect(screen.queryByText("Connected Linear via MCP.")).toBeNull();
  });

  it("adopts an accessible callback team with the real workspace provider", async () => {
    realWorkspace = true;
    window.history.replaceState(null, "", "/integrations?teamId=a&connected=linear");
    mount();
    expect(await screen.findByText("Connected Linear via MCP.")).toBeTruthy();
    expect(await screen.findByText("Linear MCP")).toBeTruthy();
    expect(window.localStorage.getItem("valet:workspace")).toBe("a");
    expect(screen.getByRole("button", { name: "Stop sharing Linear with Team A" })).toBeTruthy();
    expect(api.listCredentials).toHaveBeenCalledWith("team", "a");
  });

  it("shows the callback error when the real workspace provider rejects a lost team", async () => {
    realWorkspace = true;
    window.history.replaceState(null, "", "/integrations?teamId=gone&error=team_access_changed");
    mount();
    expect(await screen.findByText("Team access changed. Ask a team admin to restart the connection.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Connect Typefully" })).toBeTruthy();
    expect(window.localStorage.getItem("valet:workspace")).toBe("user");
    expect(screen.queryByText("Team unavailable")).toBeNull();
    expect(api.listCredentials).not.toHaveBeenCalled();
  });

  it("keeps Slack organization-managed while blocking missing OAuth configuration", async () => {
    teamId = "a";
    vi.mocked(api.listPlugins).mockResolvedValue({ plugins: [{ name: "demo", version: "1", actionCount: 0,
      services: [
        { service: "gmail", type: "oauth2", configKeys: ["accessToken"], connected: false, connect: "unconfigured", connectBlockedBy: "deployment", actions: [] },
        { service: "slack", type: "api_key", configKeys: ["accessToken"], connected: false, connect: "unconfigured", connectBlockedBy: "org", actions: [] },
        { service: "github", type: "oauth2", configKeys: ["accessToken"], connected: true, connect: "manual", actions: [] },
      ],
    }] });
    mount();
    expect((await screen.findByRole("button", { name: "Connect Gmail" })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Ask an organization admin to configure OAuth for this service.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Slack" })).toBeNull();
    expect(screen.getByText("Slack")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
  });

  it("keeps connection controls disabled for ordinary team members", async () => {
    teamId = "a";
    teams = [team("a", "Team A", "member")];
    mount();
    expect((await screen.findByRole("button", { name: "Connect Typefully" })).hasAttribute("disabled")).toBe(true);
  });
});

describe("Organization access status", () => {
  it.each([
    { configured: false, installationCount: 0, suspendedCount: 0, label: "" },
    { configured: true, installationCount: 0, suspendedCount: 0, label: "" },
    { configured: true, installationCount: 2, suspendedCount: 1, label: "Installed" },
    { configured: true, installationCount: 2, suspendedCount: 2, label: "Suspended" },
  ])("shows $label for the org GitHub state ($installationCount installations, $suspendedCount suspended)", async ({ label, ...status }) => {
    teamId = "a";
    orgRole = "admin";
    vi.mocked(api.listPlugins).mockResolvedValue(ORG_PLUGINS);
    vi.mocked(api.getGithubOrgStatus).mockResolvedValue(status);
    mount();
    expect(await screen.findByText(`GitHub App${label ? ` · ${label}` : ""}`)).toBeTruthy();
    expect(screen.getByText("Slack · Organization connection")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Organization settings" }).getAttribute("href")).toBe("/settings/organization");
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Slack" })).toBeNull();
  });

  it("keeps pending org status unknown despite a personally connected GitHub account", async () => {
    teamId = "a";
    vi.mocked(api.listPlugins).mockResolvedValue(ORG_PLUGINS);
    let resolveStatus: (status: GetGithubOrgStatusResponse) => void = () => {};
    vi.mocked(api.getGithubOrgStatus).mockReturnValue(new Promise((resolve) => { resolveStatus = resolve; }));
    mount();
    await screen.findByText("Slack · Organization connection");
    expect(screen.getByText("Loading organization access…")).toBeTruthy();
    expect(screen.queryByText(/GitHub App ·/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Organization settings" })).toBeNull();
    await act(async () => resolveStatus({ configured: false, installationCount: 0, suspendedCount: 0 }));
    expect(await screen.findByText("GitHub App")).toBeTruthy();
  });

  it("suppresses stale org status during refetch and after failure", async () => {
    teamId = "a";
    vi.mocked(api.listPlugins).mockResolvedValue(ORG_PLUGINS);
    vi.mocked(api.getGithubOrgStatus).mockResolvedValue({ configured: true, installationCount: 1, suspendedCount: 0 });
    const view = mount();
    await screen.findByText("GitHub App · Installed");
    let rejectStatus: (error: Error) => void = () => {};
    vi.mocked(api.getGithubOrgStatus).mockReturnValue(new Promise((_resolve, reject) => { rejectStatus = reject; }));
    vi.mocked(api.listPlugins).mockRejectedValue(new Error("Personal catalog unavailable"));
    await act(async () => {
      void view.client.invalidateQueries({ queryKey: qkRepos.githubOrgStatus() });
      await view.client.invalidateQueries({ queryKey: qkIntegrations.plugins("a") });
    });
    await waitFor(() => expect(screen.queryByText("GitHub App · Installed")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Slack · Organization connection")).toBeNull());
    await act(async () => rejectStatus(new Error("Unavailable")));
    expect(await screen.findByText("Could not load GitHub App status. Reload the page.")).toBeTruthy();
    expect(screen.getByText("Could not load organization access. Reload the page.")).toBeTruthy();
    expect(screen.queryByText(/· (Installed|Organization connection|Setup required)/)).toBeNull();
  });

  it("does not turn a personal Slack connection into organization access", async () => {
    teamId = "a";
    vi.mocked(api.listPlugins).mockResolvedValue({ plugins: [{ name: "slack", version: "1", actionCount: 0, services: [
      { service: "slack", type: "bot_token", configKeys: ["accessToken"], connected: true, connect: "unconfigured", connectBlockedBy: "org", actions: [] },
    ] }] });
    mount();
    expect(await screen.findByText("Slack")).toBeTruthy();
    expect(screen.queryByText("Slack · Organization connection")).toBeNull();
  });
});
