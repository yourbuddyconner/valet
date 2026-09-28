// @vitest-environment jsdom
/**
 * `/integrations` (post-facelift): Services vs Built-in grouping, friendly
 * display names, honest reach meta ("N tools" / "no key needed" /
 * "built in"), the token reveal-form Connect flow (the action is named
 * "Connect" end to end), and confirm-gated Disconnect. Mocks
 * `~/api/integrations` the same way `-workflows.index.test.tsx` mocks its
 * api module — this suite cares that the page renders from query data and
 * calls the right mutation, not that TanStack Query works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApiError } from "~/api/client";
import { SEARCH_DEBOUNCE_MS } from "~/components/search-input";
import type {
  GetGithubOrgStatusResponse,
  IdentityLinkStatus,
  ListPluginsResponse,
  OrgResponse,
  PluginServiceSummary,
} from "@valet/api/wire";

vi.mock("~/api/workflows", () => ({ useTriggerCatalog: () => ({ data: { catalog: [] } }) }));

const pluginsData = {
  plugins: [
    {
      name: "github",
      version: "0.1.0",
      description: "GitHub integration for PRs, issues, repos, and webhooks",
      actionCount: 29,
      services: [
        {
          service: "github",
          type: "oauth2" as const,
          configKeys: ["accessToken"],
          connectLabel: "Connect GitHub (via GitHub App)",
          connected: false,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
    {
      name: "typefully",
      version: "0.1.0",
      actionCount: 0,
      dynamic: true as const,
      services: [
        {
          service: "typefully",
          type: "api_key" as const,
          configKeys: ["accessToken"],
          connectLabel: "Typefully API key",
          connected: false,
          dynamic: true as const,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
    {
      name: "slack",
      version: "0.1.0",
      actionCount: 11,
      services: [
        {
          service: "slack",
          type: "bot_token" as const,
          configKeys: ["accessToken"],
          connected: true,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
    {
      // Dynamic tools, no credential declaration (the deepwiki shape) —
      // must land in Services with "no key needed", not in Built in.
      name: "deepwiki",
      version: "0.1.0",
      description: "DeepWiki integration for repository knowledge base",
      actionCount: 0,
      dynamic: true as const,
      services: [],
    },
    {
      // Content-only plugin — Built in group, no connect affordance.
      name: "sandbox-tunnels",
      version: "0.1.0",
      description: "Expose sandbox ports",
      actionCount: 0,
      services: [],
    },
  ],
};

const oauthPluginsData = {
  plugins: [
    {
      name: "linear",
      version: "0.1.0",
      description: "Linear issue tracking",
      // Linear resolves its tools from an MCP server, so it declares none
      // statically and reports `dynamic` — the real shape on the wire.
      actionCount: 0,
      dynamic: true as const,
      services: [
        {
          service: "linear",
          type: "oauth2" as const,
          configKeys: ["accessToken"],
          connected: false,
          connect: "oauth" as const,
          dynamic: true as const,
          actions: [],
        },
      ],
    },
  ],
};

const manualOnlyPluginsData = {
  plugins: [
    {
      name: "typefully",
      version: "0.1.0",
      actionCount: 0,
      dynamic: true as const,
      services: [
        {
          service: "typefully",
          type: "api_key" as const,
          configKeys: ["accessToken"],
          connectLabel: "Typefully API key",
          connected: false,
          dynamic: true as const,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
  ],
};

const githubPluginsData: ListPluginsResponse = {
  plugins: [
    {
      name: "github",
      version: "0.1.0",
      description: "GitHub integration for PRs, issues, repos, and webhooks",
      actionCount: 29,
      services: [
        {
          service: "github",
          type: "oauth2" as const,
          configKeys: ["accessToken"],
          connected: false,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
  ],
};

let currentPluginsData: ListPluginsResponse = pluginsData;
let currentOrgStatus: GetGithubOrgStatusResponse | undefined;
let currentOrg: OrgResponse | undefined;
/** The search params the page is rendered with, and where it navigates.
 * The settled query lives here, never in component state. */
let searchParams: Record<string, string> = {};
const navigate = vi.fn();

const connectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const disconnectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const disconnectMutate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useSearch: () => searchParams,
  useNavigate: () => navigate,
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({
    data: {
      id: "u1",
      email: "person@example.com",
      name: "Signed In Person",
      avatarUrl: null,
      role: "member",
      orgId: "o1",
      orgRole: "member",
      defaultModel: null,
    },
  }),
  useTeams: () => ({ data: { teams: [] } }),
  useOrg: () => ({ data: currentOrg }),
}));

vi.mock("~/api/repos", () => ({
  useConnectGithub: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useGithubOrgStatus: (enabled = true) => ({ data: enabled ? currentOrgStatus : undefined }),
}));

vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: currentPluginsData, isLoading: false, error: null }),
  useCredentials: () => ({ data: { credentials: [] }, isLoading: false, error: null }),
  useConnectCredential: () => ({ mutateAsync: connectMutateAsync, isPending: false, error: null }),
  useDisconnectCredential: () => ({
    mutate: disconnectMutate,
    mutateAsync: disconnectMutateAsync,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
  useDelegateCredential: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useRevokeDelegation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock("~/api/onepassword", () => ({
  useOnePasswordSettings: () => ({
    data: {
      allowPersonal: false,
      orgTokenConnected: false,
      personalTokenConnected: false,
    },
    isLoading: false,
    error: null,
  }),
  usePutOnePasswordSettings: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

// The org-provided tile's pairing block (identity-link-block.tsx) reads
// these three hooks. importOriginal: see -new-session-dialog.test.tsx for
// why a bare replacement is unsafe under vitest.config.ts's isolate:false.
let identityLinksData: { links: IdentityLinkStatus[] } | undefined;
let identityLinksLoading = false;
let linkMembersData: { members: Array<{ externalId: string; displayName: string; handle: string }> } | undefined;
const startLinkMutateAsync = vi.fn();
const deliverLinkMutateAsync = vi.fn();
const unlinkIdentityMutate = vi.fn();

vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useIdentityLinks: () => ({ data: identityLinksData, isLoading: identityLinksLoading, error: null }),
    useStartIdentityLink: () => ({ mutateAsync: startLinkMutateAsync, isPending: false }),
    useDeliverIdentityLink: () => ({ mutateAsync: deliverLinkMutateAsync, isPending: false }),
    useLinkMembers: (_provider: string, query: string, enabled: boolean) => ({
      data: enabled && query !== "" ? linkMembersData : undefined,
      isLoading: false,
      isError: false,
      error: null,
    }),
    useUnlinkIdentity: (_provider: string) => ({ mutate: unlinkIdentityMutate, isPending: false , reset: vi.fn() }),
  };
});

import { IntegrationsPage } from "./integrations";

// File-level, so a describe that sets a search query cannot leak it into
// the suites below it.
beforeEach(() => {
  searchParams = {};
  navigate.mockReset();
});

function org(callerRole: "admin" | "member", organizations = true): OrgResponse {
  return {
    id: "o1",
    name: "Acme",
    createdAt: 0,
    features: { organizations, ssoTeamSync: false },
    ssoTeamGroups: [],
    allowPublicArtifacts: false,
    plugins: [],
    callerRole,
  };
}

describe("IntegrationsPage", () => {
  beforeEach(() => {
    currentPluginsData = pluginsData;
    currentOrgStatus = { configured: true, installationCount: 1, suspendedCount: 0 };
    currentOrg = org("member");
    connectMutateAsync.mockClear();
    disconnectMutateAsync.mockClear();
    disconnectMutate.mockClear();
    identityLinksData = undefined;
    startLinkMutateAsync.mockReset();
    unlinkIdentityMutate.mockClear();
  });

  it("links to the personal GitHub installation page when the API permits it", () => {
    currentOrgStatus = {
      configured: true,
      installationCount: 1,
      suspendedCount: 0,
      personalInstallUrl: "https://github.example/apps/valet/installations/new",
    };
    render(<IntegrationsPage />);
    const link = screen.getByRole("link", { name: "Install on personal account" });
    expect(link.getAttribute("href")).toBe("https://github.example/apps/valet/installations/new");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("does not link to the personal GitHub installation page when the API omits it", () => {
    render(<IntegrationsPage />);
    expect(screen.queryByRole("link", { name: "Install on personal account" })).toBeNull();
  });

  it("lists connectable services only, with friendly names and honest reach meta", () => {
    render(<IntegrationsPage />);

    // Friendly names, not raw ids.
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Typefully")).toBeTruthy();
    expect(screen.getByText("DeepWiki")).toBeTruthy();
    expect(screen.queryByText("github")).toBeNull();

    // Reach meta per shape.
    expect(screen.getByText("29 tools")).toBeTruthy();
    expect(screen.getByText("tools load on connect")).toBeTruthy(); // typefully: dynamic + credential
    expect(screen.getByText("no key needed")).toBeTruthy(); // deepwiki: dynamic, no credential

    // Content-only plugins are not listed at all. They need no credential
    // and offer no action, so their row was one nobody could use.
    expect(screen.queryByText("Sandbox tunnels")).toBeNull();
    expect(screen.queryByText("built in")).toBeNull();
    expect(screen.queryByText("Built in")).toBeNull();

    expect(screen.getByText("Services")).toBeTruthy();
    expect(screen.queryByText("Nothing to connect for this plugin.")).toBeNull();
    expect(screen.queryByText(/0 actions/)).toBeNull();

    // Connected state.
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("shows a config-declared MCP server by its displayName, never the mcp-config: id", () => {
    currentPluginsData = {
      plugins: [
        {
          name: "mcp-config:grafana",
          version: "0.0.0",
          displayName: "Grafana Cloud",
          description: "Grafana Cloud integration for dashboards and alerts",
          actionCount: 0,
          dynamic: true as const,
          services: [
            {
              service: "grafana",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: false,
              connect: "oauth" as const,
              dynamic: true as const,
              actions: [],
            },
          ],
        },
        {
          // An api that predates `displayName` on the wire: the client
          // still strips the mcp-config: prefix before title-casing.
          name: "mcp-config:pylon",
          version: "0.0.0",
          actionCount: 0,
          dynamic: true as const,
          services: [],
        },
        {
          // Multi-word slug, no wire displayName: every word capitalizes,
          // matching the server's titleCaseSlug fallback.
          name: "mcp-config:pager-duty",
          version: "0.0.0",
          actionCount: 0,
          dynamic: true as const,
          services: [],
        },
      ],
    };
    render(<IntegrationsPage />);
    expect(screen.getByText("Grafana Cloud")).toBeTruthy();
    expect(screen.getByText("Pylon")).toBeTruthy();
    expect(screen.getByText("Pager Duty")).toBeTruthy();
    expect(screen.queryByText(/Mcp config/)).toBeNull();
  });

  it("built-in plugins get no connect affordance; deepwiki (keyless) gets none either", () => {
    render(<IntegrationsPage />);
    // Only github + typefully are connectable → exactly two Connect buttons.
    // Each names its own service, so a screen reader can tell them apart.
    expect(screen.getAllByRole("button", { name: /^Connect / })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Typefully" })).toBeTruthy();
  });

  it("connects via PUT after the pre-connect screen — the action is named Connect throughout", async () => {
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Typefully" }));

    // The disclosure comes first; the token field is one step behind it.
    expect(screen.getByText("Set up your Typefully connection")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const textarea = screen.getByLabelText("API key") as HTMLTextAreaElement;
    expect(screen.getByText("Typefully API key")).toBeTruthy(); // connectLabel as guidance copy
    fireEvent.change(textarea, { target: { value: "tf-key-123" } });

    // The submit is still "Connect" (never "Save").
    fireEvent.click(screen.getByRole("button", { name: "Connect Typefully" }));

    await waitFor(() => expect(connectMutateAsync).toHaveBeenCalledTimes(1));
    expect(connectMutateAsync).toHaveBeenCalledWith({
      service: "typefully",
      body: { type: "api_key", apiKey: "tf-key-123" },
    });
  });

  it("confirms then disconnects a connected service", async () => {
    render(<IntegrationsPage />);

    // The row's button only OPENS the dialog. Nothing is disconnected yet —
    // this is the assertion that a native confirm() could not carry, because
    // browser automation auto-accepts one.
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Slack" }));
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Disconnect Slack?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(disconnectMutate).toHaveBeenCalledWith(
        { service: "slack" },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      ),
    );
  });

  it("cancelling the disconnect dialog disconnects nothing", () => {
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Slack" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(disconnectMutateAsync).not.toHaveBeenCalled();
  });

  it("offers Share with a team on a connected personal service", () => {
    render(<IntegrationsPage />);
    expect(screen.getByRole("button", { name: "Share Slack with a team" })).toBeTruthy();
  });

  it("opens the pre-connect screen for an oauth service instead of redirecting on click", () => {
    // This used to be a bare anchor straight at /api/credentials/:s/connect,
    // which left no moment to say what the credential gives away.
    currentPluginsData = oauthPluginsData;
    render(<IntegrationsPage />);

    expect(screen.queryByRole("link", { name: "Connect Linear" })).toBeNull();
    screen.getByText("Optional MCP tools").closest("details")!.open = true;
    fireEvent.click(screen.getByRole("button", { name: "Connect via MCP" }));

    expect(screen.getByText("Set up your Linear via MCP connection")).toBeTruthy();
    expect(screen.getByLabelText("What your assistant can do")).toBeTruthy();
    expect(screen.getByLabelText("Who can reach it")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("oauth services still offer manual token entry, behind the disclosure", () => {
    currentPluginsData = oauthPluginsData;
    render(<IntegrationsPage />);
    screen.getByText("Optional MCP tools").closest("details")!.open = true;
    fireEvent.click(screen.getByRole("button", { name: "Connect via MCP" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter a token instead" }));
    expect(screen.getByLabelText("Access token")).toBeTruthy();
  });

  it("manual services render the token-entry Connect button, not an anchor", () => {
    currentPluginsData = manualOnlyPluginsData;
    render(<IntegrationsPage />);
    expect(screen.queryByRole("link", { name: "Connect Typefully" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect Typefully" })).toBeTruthy();
  });

  it("shows a success notice for ?connected= and an error notice for ?error=", () => {
    window.history.replaceState(null, "", "/integrations?connected=linear");
    const { unmount } = render(<IntegrationsPage />);
    expect(screen.getByText(/Connected linear/i)).toBeTruthy();
    unmount();

    window.history.replaceState(null, "", "/integrations?error=access_denied");
    render(<IntegrationsPage />);
    expect(screen.getByText(/access_denied/)).toBeTruthy();
  });

  it("renders the server-composed detail over the generic fallback", () => {
    window.history.replaceState(
      null,
      "",
      "/integrations?error=oauth_failed&detail=" +
        encodeURIComponent("Slack returned no user token. Reinstall the Slack app, then connect again."),
    );
    render(<IntegrationsPage />);
    expect(
      screen.getByText("Slack returned no user token. Reinstall the Slack app, then connect again."),
    ).toBeTruthy();
  });

  it("maps identity_conflict to a human-readable message naming the corrective action", () => {
    window.history.replaceState(null, "", "/integrations?error=identity_conflict");
    render(<IntegrationsPage />);
    expect(
      screen.getByText(
        "This Slack account is already linked to another Valet user. Unlink it there first, or sign in as that user.",
      ),
    ).toBeTruthy();
  });
});

describe("brand marks", () => {
  it("draws a different mark per service instead of one letter each", () => {
    currentPluginsData = {
      plugins: ["github", "gmail", "google-calendar"].map((name) => ({
        name,
        version: "0.1.0",
        actionCount: 1,
        services: [
          {
            service: name,
            type: "oauth2" as const,
            configKeys: ["accessToken"],
            connected: false,
            connect: "manual" as const,
            actions: [],
            iconSlug: name,
          },
        ],
      })),
    };
    const { container } = render(<IntegrationsPage />);
    const services = [...container.querySelectorAll("section")].find(
      (section) => section.querySelector("h2")?.textContent === "Services",
    );
    const paths = [...(services?.querySelectorAll("svg path") ?? [])].map((p) => p.getAttribute("d"));
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
  });
});

describe("connection health", () => {
  function connectedGmail(health: PluginServiceSummary["health"]): ListPluginsResponse {
    return {
      plugins: [
        {
          name: "gmail",
          version: "0.1.0",
          actionCount: 6,
          services: [
            {
              service: "gmail",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: true,
              connect: "oauth" as const,
              actions: [],
              iconSlug: "gmail",
              health,
            },
          ],
        },
      ],
    };
  }

  it("names the connected account", () => {
    currentPluginsData = connectedGmail({ login: "someone@example.com" });
    render(<IntegrationsPage />);
    expect(screen.getByText(/someone@example.com/)).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect Gmail" })).toBeNull();
  });

  it("shows the fix and a Reconnect control when the token expired", () => {
    currentPluginsData = connectedGmail({ login: "someone@example.com", expiresAt: Date.now() - 1000 });
    render(<IntegrationsPage />);

    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByText(/Select Reconnect to sign in again/)).toBeTruthy();
    // The repair opens the same pre-connect screen, and Disconnect stays available.
    expect(screen.queryByRole("link", { name: "Reconnect Gmail" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect Gmail" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Gmail" })).toBeTruthy();
  });

  it("shows the fix when the last refresh failed", () => {
    currentPluginsData = connectedGmail({ refreshFailed: true });
    render(<IntegrationsPage />);
    expect(screen.getByText("Refresh failed")).toBeTruthy();
    expect(screen.getByText(/The last token refresh failed/)).toBeTruthy();
  });

  it("shows the fix when the grant carries identity only", () => {
    currentPluginsData = connectedGmail({ identityOnly: true });
    render(<IntegrationsPage />);
    expect(screen.getByText("Sign-in only")).toBeTruthy();
    expect(screen.getByText(/add the permissions the tools need/)).toBeTruthy();
  });

  it("keeps the plain Connected badge when the wire reports no health", () => {
    currentPluginsData = connectedGmail(undefined);
    render(<IntegrationsPage />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect Gmail" })).toBeNull();
  });
});

describe("connected dynamic service tool count", () => {
  it("shows the resolved toolCount instead of 'tools load on connect' once connected", () => {
    currentPluginsData = {
      plugins: [
        {
          name: "linear",
          version: "0.1.0",
          actionCount: 0,
          dynamic: true as const,
          services: [
            {
              service: "linear",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: true,
              dynamic: true as const,
              connect: "oauth" as const,
              actions: [],
              toolCount: 52,
            },
          ],
        },
      ],
    };
    render(<IntegrationsPage />);
    expect(screen.getByText(/^52 tools$/)).toBeTruthy();
    expect(screen.queryByText("tools load on connect")).toBeNull();
  });

  it("keeps the static label when connected but toolCount is absent (resolution failed)", () => {
    currentPluginsData = {
      plugins: [
        {
          name: "linear",
          version: "0.1.0",
          actionCount: 0,
          dynamic: true as const,
          services: [
            {
              service: "linear",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: true,
              dynamic: true as const,
              connect: "oauth" as const,
              actions: [],
            },
          ],
        },
      ],
    };
    render(<IntegrationsPage />);
    expect(screen.getByText(/^tools load on connect$/)).toBeTruthy();
  });
});

/**
 * The organisation's GitHub App, on the GitHub card.
 *
 * An admin who set up an App found nothing here acknowledging it, and the
 * card offered the same plain "Connect" whether the organisation had three
 * installations or no App at all — in which case that button can only fail.
 * These assert the card reports the App's real state and points at the page
 * that owns it, without ever suggesting the App and the personal credential
 * are one connection.
 */
describe("the organisation's GitHub App", () => {
  beforeEach(() => {
    currentPluginsData = githubPluginsData;
    currentOrgStatus = { configured: true, installationCount: 2, suspendedCount: 0 };
    currentOrg = org("member");
  });

  it("counts the accounts the App reaches, and says the App is not the user", () => {
    render(<IntegrationsPage />);
    expect(screen.getByText("Org App installed")).toBeTruthy();
    expect(
      screen.getByText(/GitHub App reaches 2 GitHub accounts\. It acts as your organisation, not as you\./),
    ).toBeTruthy();
  });

  it("names the missed install and links an admin to the page that owns it", () => {
    // GitHub's creation flow ends without prompting for the install, so an
    // App with no installation is the state people actually land in.
    currentOrgStatus = { configured: true, installationCount: 0, suspendedCount: 0 };
    currentOrg = org("admin");
    render(<IntegrationsPage />);

    expect(screen.getByText("Org App not installed")).toBeTruthy();
    expect(screen.getByText(/nobody installed it on a GitHub account/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Finish the install" });
    expect(link.getAttribute("href")).toBe("/settings/organization/github");
  });

  it("tells a member who to ask, rather than linking to a page they cannot open", () => {
    currentOrgStatus = { configured: true, installationCount: 0, suspendedCount: 0 };
    render(<IntegrationsPage />);

    expect(screen.getByText(/Ask an org admin to install it\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Finish the install" })).toBeNull();
  });

  it("hides the link from a gate-off admin, whose App page shows the same refusal", () => {
    currentOrg = org("admin", false);
    render(<IntegrationsPage />);
    expect(screen.queryByRole("link", { name: /App/ })).toBeNull();
  });

  it("says the organisation has no App on a disconnected card, where Connect is about to fail", () => {
    currentOrgStatus = { configured: false, installationCount: 0, suspendedCount: 0 };
    render(<IntegrationsPage />);

    // The card is disconnected, so the note stack used to render nothing at
    // all — which is the state that most needed the explanation.
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
    expect(screen.getByText("No org App")).toBeTruthy();
    expect(screen.getByText(/Valet signs you in to GitHub through that App/)).toBeTruthy();
  });

  it("reports a suspended App as reaching nothing, not as installed", () => {
    currentOrgStatus = { configured: true, installationCount: 2, suspendedCount: 2 };
    render(<IntegrationsPage />);
    expect(screen.getByText("Org App suspended")).toBeTruthy();
    expect(screen.queryByText(/reaches \d+ GitHub/)).toBeNull();
  });

  it("keeps the org App's badge distinct from the personal credential's", () => {
    currentPluginsData = {
      plugins: [
        {
          ...githubPluginsData.plugins[0],
          services: [{ ...githubPluginsData.plugins[0].services[0], connected: true }],
        },
      ],
    };
    render(<IntegrationsPage />);
    // Two connections, two badges. "Connected" is this user's credential;
    // the App carries its own label and never borrows that one.
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Org App installed")).toBeTruthy();
  });

  it("claims nothing while the org status is unknown", () => {
    currentOrgStatus = undefined;
    render(<IntegrationsPage />);
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByText(/Org App/)).toBeNull();
    expect(screen.queryByText(/No org App/)).toBeNull();
  });

  it("leaves every other service's card alone", () => {
    currentPluginsData = pluginsData;
    render(<IntegrationsPage />);
    // One GitHub card, one org line — Slack and Typefully have no org half.
    expect(screen.getAllByText(/Org App/)).toHaveLength(1);
  });
});

/**
 * Availability tri-state (integration-availability design): the wire says
 * "unconfigured" when the org/deployment prerequisite is missing. An
 * unconfigured, unconnected service does not render at all; a leftover
 * credential keeps its tile for Disconnect, with the admin note and no
 * Connect control.
 */
describe("unconfigured services", () => {
  const unconfiguredPluginsData: ListPluginsResponse = {
    plugins: [
      {
        name: "slack",
        version: "0.1.0",
        actionCount: 11,
        services: [
          {
            service: "slack",
            type: "bot_token" as const,
            configKeys: ["accessToken"],
            connected: false,
            connect: "unconfigured" as const,
            actions: [],
          },
        ],
      },
      {
        name: "gmail",
        version: "0.1.0",
        actionCount: 4,
        services: [
          {
            service: "gmail",
            type: "oauth2" as const,
            configKeys: ["accessToken"],
            connected: true,
            connect: "unconfigured" as const,
            actions: [],
          },
        ],
      },
      {
        name: "typefully",
        version: "0.1.0",
        actionCount: 0,
        dynamic: true as const,
        services: [
          {
            service: "typefully",
            type: "api_key" as const,
            configKeys: ["accessToken"],
            connected: false,
            connect: "manual" as const,
            actions: [],
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    currentPluginsData = unconfiguredPluginsData;
    currentOrgStatus = { configured: true, installationCount: 1, suspendedCount: 0 };
    currentOrg = org("member");
  });

  it("hides an unconfigured, unconnected service from the grid", () => {
    render(<IntegrationsPage />);

    expect(screen.queryByText("Slack")).toBeNull();
    // A configured manual service still lists.
    expect(screen.getByText("Typefully")).toBeTruthy();
  });

  it("keeps a connected-but-unconfigured service visible for Disconnect, with the admin note", () => {
    render(<IntegrationsPage />);

    expect(screen.getByText("Gmail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Gmail" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect Gmail/ })).toBeNull();
    expect(screen.getByText(/Not configured for this organization/)).toBeTruthy();
  });
});

/**
 * An unconfigured service whose fix is a deployment setting. `missingEnv`
 * arrives on the wire ONLY for an org admin — the API omits the key for
 * everybody else — so the field's presence decides the tile and which note
 * it carries. `connectBlockedBy` arrives for everybody, and it keeps the
 * member's note off a page that cannot perform the fix. The row stays
 * informational: no Connect button can work while the server has no OAuth
 * client.
 */
describe("an unconfigured service an org admin can fix", () => {
  /** The API sends `connectBlockedBy: "deployment"` to every caller for this
   * cause, and `missingEnv` to an org admin alone. */
  function calendarPlugins(
    opts: { missingEnv?: string[]; connected?: boolean } = {},
  ): ListPluginsResponse {
    return {
      plugins: [
        {
          name: "google-calendar",
          version: "0.1.0",
          description: "Read and write Google Calendar events",
          actionCount: 8,
          services: [
            {
              service: "google-calendar",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: opts.connected ?? false,
              connect: "unconfigured" as const,
              connectBlockedBy: "deployment" as const,
              ...(opts.missingEnv ? { missingEnv: opts.missingEnv } : {}),
              actions: [],
            },
          ],
        },
      ],
    };
  }

  const bothUnset = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];

  beforeEach(() => {
    currentOrgStatus = { configured: true, installationCount: 1, suspendedCount: 0 };
    currentOrg = org("admin");
  });

  it("shows the tile and names both variables when the wire carries them", () => {
    currentPluginsData = calendarPlugins({ missingEnv: bothUnset });
    render(<IntegrationsPage />);

    expect(screen.getByText("Google Calendar")).toBeTruthy();
    expect(screen.getByText("GOOGLE_CLIENT_ID")).toBeTruthy();
    expect(screen.getByText("GOOGLE_CLIENT_SECRET")).toBeTruthy();
    expect(screen.getByText(/Then restart the server/)).toBeTruthy();
  });

  it("names only the unset half of a half-set pair", () => {
    currentPluginsData = calendarPlugins({ missingEnv: ["GOOGLE_CLIENT_SECRET"] });
    render(<IntegrationsPage />);

    expect(screen.getByText("GOOGLE_CLIENT_SECRET")).toBeTruthy();
    expect(screen.queryByText("GOOGLE_CLIENT_ID")).toBeNull();
  });

  it("prints whatever variables the wire names, with no hardcoded Google knowledge", () => {
    currentPluginsData = calendarPlugins({ missingEnv: ["DROPBOX_CLIENT_ID", "DROPBOX_CLIENT_SECRET"] });
    render(<IntegrationsPage />);

    expect(screen.getByText("DROPBOX_CLIENT_ID")).toBeTruthy();
    expect(screen.getByText("DROPBOX_CLIENT_SECRET")).toBeTruthy();
  });

  it("offers no Connect control — the fix is on the server, not in the browser", () => {
    currentPluginsData = calendarPlugins({ missingEnv: bothUnset });
    render(<IntegrationsPage />);

    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect/ })).toBeNull();
  });

  it("hides the same service from a member, whose wire carries no missingEnv", () => {
    // Byte-for-byte the pre-change behaviour: no key, no tile, no names.
    currentPluginsData = calendarPlugins();
    currentOrg = org("member");
    render(<IntegrationsPage />);

    expect(screen.queryByText("Google Calendar")).toBeNull();
    expect(screen.queryByText("GOOGLE_CLIENT_ID")).toBeNull();
  });

  it("sends a member with a leftover credential to a person, not to a page that cannot help", () => {
    // The operator dropped the OAuth client after this member connected. The
    // credential keeps the tile on screen, so the member reads a note. It
    // must not send them to Settings → Organization, where nothing sets a
    // server variable.
    currentPluginsData = calendarPlugins({ connected: true });
    currentOrg = org("member");
    render(<IntegrationsPage />);

    expect(screen.getByText(/Ask an org admin to set it up/)).toBeTruthy();
    expect(screen.queryByText(/Settings → Organization/)).toBeNull();
    expect(screen.queryByText("GOOGLE_CLIENT_ID")).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect Google Calendar" })).toBeTruthy();
  });

  it("keeps the org-credential note for the cause that Settings → Organization does fix", () => {
    currentPluginsData = {
      plugins: [
        {
          name: "slack",
          version: "0.1.0",
          actionCount: 11,
          services: [
            {
              service: "slack",
              type: "bot_token" as const,
              configKeys: ["accessToken"],
              connected: true,
              connect: "unconfigured" as const,
              connectBlockedBy: "org" as const,
              actions: [],
            },
          ],
        },
      ],
    };
    currentOrg = org("member");
    render(<IntegrationsPage />);

    expect(screen.getByText(/Not configured for this organization/)).toBeTruthy();
    expect(screen.queryByText(/Ask an org admin/)).toBeNull();
  });

  it("leaves a configured service alone", () => {
    currentPluginsData = {
      plugins: [
        {
          name: "google-calendar",
          version: "0.1.0",
          actionCount: 8,
          services: [
            {
              service: "google-calendar",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: false,
              connect: "oauth" as const,
              actions: [],
            },
          ],
        },
      ],
    };
    render(<IntegrationsPage />);

    expect(screen.getByRole("button", { name: "Connect Google Calendar" })).toBeTruthy();
    expect(screen.queryByText(/restart the server/)).toBeNull();
  });
});

/**
 * The org-provided tile ("org" connect mode): the org credential powers the
 * integration, so the member's only step is pairing their account through
 * the identity-link code flow. No token entry, ever.
 */
describe("IntegrationsPage — org-provided pairing", () => {
  function slackOrgPlugins(): ListPluginsResponse {
    return {
      plugins: [
        {
          name: "slack",
          version: "0.1.0",
          description: "Slack integration for messages, channels, and users",
          actionCount: 11,
          services: [
            {
              service: "slack",
              type: "bot_token" as const,
              configKeys: ["accessToken"],
              connected: false,
              connect: "org" as const,
              actions: [],
            },
          ],
        },
      ],
    };
  }

  function slackLink(overrides: Partial<IdentityLinkStatus> = {}): IdentityLinkStatus {
    return {
      provider: "slack",
      linked: false,
      channelReady: true,
      codeDelivery: false,
      memberSearch: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    currentPluginsData = slackOrgPlugins();
    currentOrg = org("member");
    identityLinksData = undefined;
    identityLinksLoading = false;
    linkMembersData = undefined;
    startLinkMutateAsync.mockReset();
    deliverLinkMutateAsync.mockReset();
    unlinkIdentityMutate.mockClear();
  });

  it("offers pairing instead of token entry when the provider declares an identity link", () => {
    identityLinksData = { links: [slackLink()] };
    render(<IntegrationsPage />);

    expect(screen.getByRole("button", { name: "Link Slack account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect Slack/ })).toBeNull();
    expect(screen.queryByText(/Provided by your organization/)).toBeNull();
  });

  it("starting the link shows the code, the provider's instructions, and the expiry", async () => {
    identityLinksData = { links: [slackLink()] };
    startLinkMutateAsync.mockResolvedValue({
      code: "VLT-1234",
      instructions: "In Slack, open a DM with the Valet app and send: link <code>",
      expiresInSeconds: 600,
    });
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Link Slack account" }));

    await waitFor(() => expect(screen.getByText("VLT-1234")).toBeTruthy());
    expect(startLinkMutateAsync).toHaveBeenCalledWith("slack");
    expect(screen.getByText(/open a DM with the Valet app/)).toBeTruthy();
    expect(screen.getByText(/expires in 10 minutes/)).toBeTruthy();
  });

  it("a linked account reads as linked, with a confirm-gated Unlink", () => {
    identityLinksData = { links: [slackLink({ linked: true, externalId: "U0123ABCD" })] };
    render(<IntegrationsPage />);

    expect(screen.getByText("U0123ABCD")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link Slack account" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    expect(unlinkIdentityMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(unlinkIdentityMutate).toHaveBeenCalled();
  });

  it("falls back to the generic org note when the provider declares no identity link", () => {
    identityLinksData = { links: [] };
    render(<IntegrationsPage />);

    expect(screen.getByText(/Provided by your organization/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Link .* account/ })).toBeNull();
  });

  it("holds both the note and the pairing block while the link list loads — no flash", () => {
    identityLinksLoading = true;
    render(<IntegrationsPage />);

    expect(screen.queryByText(/Provided by your organization/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Link .* account/ })).toBeNull();
  });

  it("offers 'DM me on Slack' when the provider reports codeDelivery", () => {
    identityLinksData = { links: [slackLink({ codeDelivery: true, memberSearch: true })] };
    render(<IntegrationsPage />);

    expect(screen.getByRole("button", { name: "DM me on Slack" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find my Slack account by name" })).toBeTruthy();
    // The show-code flow is a fallback, never a third button.
    expect(screen.queryByRole("button", { name: "Link Slack account" })).toBeNull();
  });

  it("after the DM, the card shows the recipient, the exact reply line, and the expiry", async () => {
    identityLinksData = { links: [slackLink({ codeDelivery: true })] };
    deliverLinkMutateAsync.mockResolvedValue({
      delivered: true,
      externalId: "U777",
      displayName: "conner",
      code: "VLT-1234",
      replyText: "link VLT-1234",
      expiresInSeconds: 600,
    });
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "DM me on Slack" }));

    await waitFor(() => expect(screen.getByText(/We DMed/)).toBeTruthy());
    expect(deliverLinkMutateAsync).toHaveBeenCalledWith({ provider: "slack", member: undefined });
    expect(screen.getByText("@conner")).toBeTruthy();
    // The full copyable reply line, not a bare code the transport ignores.
    expect(screen.getByText("link VLT-1234")).toBeTruthy();
    expect(screen.getByText(/Reply with:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByText(/expires in 10 minutes/)).toBeTruthy();
  });

  it("clears the reply line and stops waiting once the code expires", async () => {
    identityLinksData = { links: [slackLink({ codeDelivery: true })] };
    deliverLinkMutateAsync.mockResolvedValue({
      delivered: true,
      externalId: "U777",
      displayName: "conner",
      code: "VLT-1234",
      replyText: "link VLT-1234",
      expiresInSeconds: 1,
    });
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "DM me on Slack" }));
    await waitFor(() => expect(screen.getByText("link VLT-1234")).toBeTruthy());

    await waitFor(() => expect(screen.queryByText("link VLT-1234")).toBeNull(), { timeout: 3000 });
    expect(screen.getByText("The code expired. Start again.")).toBeTruthy();
  });

  it("falls back to member search on 202, and picking a member DMs that account", async () => {
    identityLinksData = { links: [slackLink({ codeDelivery: true, memberSearch: true })] };
    deliverLinkMutateAsync.mockResolvedValueOnce({ reason: "email_not_in_workspace" });
    linkMembersData = { members: [{ externalId: "U888", displayName: "Pat", handle: "pat" }] };
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "DM me on Slack" }));

    await waitFor(() => expect(screen.getByText(/Pick yourself from the list/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search Slack members"), { target: { value: "pat" } });
    fireEvent.submit(screen.getByLabelText("Search Slack members"));
    await waitFor(() => expect(screen.getByText("Pat")).toBeTruthy());

    deliverLinkMutateAsync.mockResolvedValueOnce({
      delivered: true,
      externalId: "U888",
      displayName: "Pat",
      code: "X",
      replyText: "link X",
      expiresInSeconds: 600,
    });
    fireEvent.click(screen.getByText("Pat"));
    await waitFor(() =>
      expect(deliverLinkMutateAsync).toHaveBeenLastCalledWith({
        provider: "slack",
        member: { externalId: "U888", displayName: "Pat" },
      }),
    );
    await waitFor(() => expect(screen.getByText(/We DMed/)).toBeTruthy());
  });

  it("falls back to the shown code when the DM send fails, and says why", async () => {
    identityLinksData = { links: [slackLink({ codeDelivery: true })] };
    deliverLinkMutateAsync.mockRejectedValue(
      new ApiError(502, "POST /me/identity-links/slack/deliver → 502", {
        error: "Could not send the slack DM: channel_not_found. Use the link code shown on the card instead.",
      }),
    );
    startLinkMutateAsync.mockResolvedValue({
      code: "VLT-9999",
      instructions: "In Slack, open a DM with the Valet app and send: link <code>",
      expiresInSeconds: 600,
    });
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "DM me on Slack" }));

    await waitFor(() => expect(screen.getByText("VLT-9999")).toBeTruthy());
    expect(screen.getByText(/Could not send the slack DM/)).toBeTruthy();
  });

  it("falls back to the shown code on 202 when the provider has no member directory", async () => {
    identityLinksData = { links: [slackLink({ codeDelivery: true, memberSearch: false })] };
    deliverLinkMutateAsync.mockResolvedValue({ reason: "email_not_in_workspace" });
    startLinkMutateAsync.mockResolvedValue({
      code: "VLT-1234",
      instructions: "In Slack, open a DM with the Valet app and send: link <code>",
      expiresInSeconds: 600,
    });
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "DM me on Slack" }));

    await waitFor(() => expect(screen.getByText("VLT-1234")).toBeTruthy());
    expect(screen.getByText(/Use the code below instead/)).toBeTruthy();
    expect(startLinkMutateAsync).toHaveBeenCalledWith("slack");
  });
});

/**
 * The search box narrows the tiles in the browser — `usePlugins` holds the
 * whole set, so a client-side match answers about everything it claims to.
 * The settled query lives in `?q=`, like the `/skills` catalog search.
 */
describe("IntegrationsPage — the search box", () => {
  beforeEach(() => {
    currentPluginsData = pluginsData;
    currentOrgStatus = { configured: true, installationCount: 1, suspendedCount: 0 };
    currentOrg = org("member");
    identityLinksData = undefined;
  });

  it("narrows the tiles to the query in the URL", () => {
    searchParams = { q: "slack" };
    render(<IntegrationsPage />);

    expect(screen.getByText("Slack")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.queryByText("DeepWiki")).toBeNull();
    expect(screen.queryByRole("heading", { name: "1Password" })).toBeNull();
  });

  it("matches the description, not just the name", () => {
    // "knowledge base" appears only in deepwiki's description.
    searchParams = { q: "knowledge base" };
    render(<IntegrationsPage />);

    expect(screen.getByText("DeepWiki")).toBeTruthy();
    expect(screen.queryByText("Slack")).toBeNull();
  });

  it("sends the search to the URL once typing settles", async () => {
    // Fake timers drive the debounce by hand; see use-live-query.test.tsx
    // for why waitFor and vitest's clock do not mix.
    vi.useFakeTimers();
    try {
      render(<IntegrationsPage />);
      const box = screen.getByLabelText("Search integrations");
      fireEvent.change(box, { target: { value: "sla" } });
      fireEvent.change(box, { target: { value: "slack" } });
      // Sending each keystroke would make every character a history entry.
      expect(navigate).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      });
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith({ to: "/integrations", search: { q: "slack" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the box up when nothing matches", () => {
    searchParams = { q: "no-such-integration" };
    render(<IntegrationsPage />);

    expect(screen.getByText("No integrations match your search.")).toBeTruthy();
    // Hiding the box on an empty page would leave no way to clear the search.
    expect(screen.getByLabelText("Search integrations")).toBeTruthy();
    expect(screen.queryByText("Services")).toBeNull();
    expect(screen.queryByRole("heading", { name: "1Password" })).toBeNull();
  });

  // 1Password moved to Organization · 1Password, beside GitHub and Slack.
  // This page answers "what can the assistant reach"; a token form and a
  // credential table are provider setup, which is what the settings rail is
  // for.
  it("does not carry the 1Password panel", () => {
    render(<IntegrationsPage />);
    expect(screen.queryByRole("heading", { name: "1Password" })).toBeNull();
  });
});
