// @vitest-environment jsdom
/**
 * `/security` hub (valet-security M7): the "New review" card refuses to
 * start without a repo, Start POSTs `kind: "security"` with the repo
 * binding and navigates to the created session, and the list below renders
 * each `kind=security` session with its engagement's status badge.
 * Router mocked the same way `-workflows.index.test.tsx` does — this suite
 * cares that navigation was requested, not that the router resolved it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  GetReposResponse,
  GetSessionSecurityResponse,
  SessionSummary,
} from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

let selectedTeamId: string | undefined;
let orgCallerRole = "member";

vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: selectedTeamId ?? "user", teamId: selectedTeamId }),
}));

const reviewsData: { sessions: SessionSummary[] } = { sessions: [] };

const engagementsBySession: Record<string, GetSessionSecurityResponse> = {
  s_1: {
    engagement: {
      id: "seng_1",
      sessionId: "s_1",
      status: "running",
      repoFullName: "acme/site",
      repoRef: "",
      plan: "cells: []",
      baseRef: null,
      changedPaths: null,
      hasRepoConfig: false,
      focus: null,
      invariants: null,
      categories: null,
      configPersonas: null,
      configTools: null,
      authorizedScope: null,
      createdAt: 1,
      updatedAt: 2,
    },
    cells: [],
    cost: { costUsd: 0, totalTokens: 0, priced: true },
    planCells: [],
    report: null,
  },
};

const reposData: GetReposResponse = {
  connected: true,
  installed: false,
  repos: [
    {
      fullName: "acme/site",
      url: "https://github.com/acme/site",
      cloneUrl: "https://github.com/acme/site.git",
      defaultBranch: "main",
      private: false,
    },
  ],
};

const navigate = vi.fn();
const createMutateAsync = vi.fn().mockResolvedValue({ id: "s_new" });
// The re-scan mutation: calls onSuccess with the created session, mirroring
// useMutation's `mutate(vars, { onSuccess })` contract.
const rescanMutate = vi.fn(
  (_vars: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) => {
    opts?.onSuccess?.({ id: "s_rescan" });
  },
);

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  // The workspace scope reads `?assistant=`; this page never renders with
  // one, so the search is always empty.
  useSearch: () => ({}),
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/queries", () => ({
  useCreateSession: () => ({ mutateAsync: createMutateAsync, isPending: false, error: null }),
}));

vi.mock("~/api/security", () => ({
  useSecurityReviews: () => ({ data: reviewsData, isLoading: false, error: null }),
  useEngagement: (sessionId: string) => ({
    data: engagementsBySession[sessionId],
    isLoading: false,
    error: null,
  }),
  useRescanReview: () => ({ mutate: rescanMutate, isPending: false, error: null }),
}));

vi.mock("~/api/repos", () => ({
  useRepos: () => ({ data: reposData, isLoading: false, error: null }),
}));

// The workspace scope provider reads the assistants list to let an open
// assistant win over the stored key; no assistant is open here.

// `useListOwner` reads the caller's own id; `WorkspaceClause` reads teams +
// org features (none here, so the clause renders nothing).
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-1" }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  useOrg: () => ({ data: { callerRole: orgCallerRole, features: { organizations: false } }, isLoading: false, error: null }),
  // No org catalog here, so the hub falls back to the curated MODEL_CATALOG.
  useModels: () => ({ data: undefined, isLoading: false, error: null }),
}));

import { SecurityIndexPage } from "./security.index";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";

function renderPage() {
  return render(
    <TooltipProvider>
      <WorkspaceScopeProvider>
        <SecurityIndexPage />
      </WorkspaceScopeProvider>
    </TooltipProvider>,
  );
}

function pickRepo() {
  const combobox = screen.getByRole("combobox", { name: "Search repositories" });
  fireEvent.focus(combobox);
  fireEvent.click(screen.getByRole("option", { name: /acme\/site/ }));
}

beforeEach(() => {
  window.localStorage.clear();
  selectedTeamId = undefined;
  orgCallerRole = "member";
  reposData.connected = true;
  reviewsData.sessions = [];
  navigate.mockClear();
  createMutateAsync.mockClear();
  rescanMutate.mockClear();
});

describe("SecurityIndexPage", () => {
  it("keeps the compact method and optional settings when configuring", () => {
    renderPage();
    pickRepo();
    fireEvent.change(screen.getByRole("combobox", { name: "Review method" }), { target: { value: "secrets-config" } });
    const options = screen.getByRole("button", { name: "Review options" });
    fireEvent.click(options);
    expect(options.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(screen.getByLabelText("Scope to paths"), { target: { value: "src/auth" } });
    fireEvent.click(options);
    expect(options.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /Configure review/ }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      search: expect.objectContaining({ preset: "secrets-config", paths: "src/auth" }),
    }));
  });

  it("shows the empty state when no security reviews exist", () => {
    renderPage();
    expect(screen.getByText("No reviews yet")).toBeTruthy();
  });

  it("renders a review row with its repo, ref, and engagement status", () => {
    reviewsData.sessions = [
      {
        id: "s_1",
        workspace: "/workspace/site",
        status: "active",
        kind: "security",
        runState: "idle",
        title: "Token audit",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        lastActivityAt: 1700000000000,
        owner: { type: "user", id: "u-1" },
      },
    ];
    renderPage();

    // The row leads with the repo (mono), links to the session, and shows the
    // engagement status label.
    const link = screen.getByText("acme/site").closest("a");
    expect(link).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText("No reviews yet")).toBeNull();
    // A running engagement offers no re-scan — there is nothing to iterate on.
    expect(screen.queryByRole("button", { name: "Re-scan" })).toBeNull();
  });

  it("offers Re-scan only on a terminal engagement and starts a re-scan", () => {
    // A completed engagement for the row.
    engagementsBySession.s_done = {
      engagement: {
        id: "seng_done",
        sessionId: "s_done",
        status: "completed",
        repoFullName: "acme/site",
        repoRef: "b".repeat(40),
        plan: "cells: []",
        baseRef: null,
        changedPaths: null,
        hasRepoConfig: false,
        focus: null,
        invariants: null,
        categories: null,
        configPersonas: null,
        configTools: null,
        authorizedScope: null,
        createdAt: 1,
        updatedAt: 2,
      },
      cells: [],
      cost: { costUsd: 0, totalTokens: 0, priced: true },
      planCells: [],
      report: null,
    };
    reviewsData.sessions = [
      {
        id: "s_done",
        workspace: "/workspace/site",
        status: "active",
        kind: "security",
        runState: "idle",
        title: "Prior review",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        lastActivityAt: 1700000000000,
        owner: { type: "user", id: "u-1" },
      },
    ];
    renderPage();

    const button = screen.getByRole("button", { name: "Re-scan" });
    fireEvent.click(button);
    expect(rescanMutate).toHaveBeenCalledTimes(1);
    expect(rescanMutate.mock.calls[0][0]).toMatchObject({ rescanOf: "s_done" });
    // onSuccess navigated to the new session.
    expect(navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "s_rescan" },
    });
    delete engagementsBySession.s_done;
  });

  it("keeps Configure disabled until a repo is picked", () => {
    renderPage();
    const configure = screen.getByRole("button", { name: "Configure review →" }) as HTMLButtonElement;
    expect(configure.disabled).toBe(true);

    pickRepo();
    expect(configure.disabled).toBe(false);
  });

  it("Configure navigates to /security/new with the repo, preset, and model", () => {
    renderPage();
    pickRepo();
    fireEvent.click(screen.getByRole("button", { name: "Configure review →" }));

    // The hub no longer creates the session — it hands off to the setup page.
    expect(createMutateAsync).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
    const call = navigate.mock.calls[0][0] as { to: string; search: Record<string, unknown> };
    expect(call.to).toBe("/security/new");
    expect(call.search).toMatchObject({
      repo: "acme/site",
      cloneUrl: "https://github.com/acme/site.git",
      ref: "main",
      preset: "code-review",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("passes the picked model and preset in the setup-page search", () => {
    renderPage();
    pickRepo();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "anthropic/claude-opus-5" } });
    // The method is a card radiogroup now, not a select.
    fireEvent.click(screen.getByRole("radio", { name: "Secrets & config" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure review →" }));

    const call = navigate.mock.calls[0][0] as { search: Record<string, unknown> };
    expect(call.search).toMatchObject({ model: "anthropic/claude-opus-5", preset: "secrets-config" });
  });

  it("passes the paths scope as a comma-joined param and omits it when blank", () => {
    renderPage();
    pickRepo();
    fireEvent.change(screen.getByLabelText("Scope to paths"), {
      target: { value: "packages/api, src/auth" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Configure review →" }));
    const call = navigate.mock.calls[0][0] as { search: Record<string, unknown> };
    expect(call.search.paths).toBe("packages/api,src/auth");
  });

  it("offers the sweep presets as cards, defaulting to full code review", () => {
    renderPage();
    const radios = screen.getAllByRole("radio");
    const labels = radios.map((r) => r.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Full code review",
      "Access & injection",
      "Secrets & config",
      "Code audit",
      "Live pentest",
      "Code audit + live confirmation",
    ]);
    // Full code review is selected by default.
    expect(screen.getByRole("radio", { name: "Full code review" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("offers a typed public repo inline in the picker and configures it (default branch)", () => {
    renderPage();
    // Type a repo the connected org does not have; the picker offers it as a
    // public repo instead of dead-ending on "No matching repos".
    fireEvent.change(screen.getByLabelText("Search repositories"), {
      target: { value: "https://github.com/openai/gpt-4" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Scan openai\/gpt-4 as a public repo/i }));

    const configure = screen.getByRole("button", { name: "Configure review →" }) as HTMLButtonElement;
    expect(configure.disabled).toBe(false);
    fireEvent.click(configure);

    const call = navigate.mock.calls[0][0] as { search: Record<string, unknown> };
    expect(call.search).toMatchObject({
      repo: "openai/gpt-4",
      cloneUrl: "https://github.com/openai/gpt-4.git",
    });
    // No ref — the setup page and server resolve the default branch HEAD.
    expect(call.search.ref).toBeUndefined();
  });
});


describe("GitHub connection recovery", () => {
  it("keeps personal GitHub setup in personal connected accounts", () => {
    reposData.connected = false;
    renderPage();
    expect(screen.getByRole("link", { name: "Connect GitHub" }).getAttribute("href"))
      .toBe("/settings/connected-accounts");
  });

  it("takes team org admins directly to GitHub App settings", () => {
    selectedTeamId = "team-a";
    orgCallerRole = "admin";
    reposData.connected = false;
    renderPage();
    expect(screen.getByRole("link", { name: "Configure the GitHub App" }).getAttribute("href"))
      .toBe("/settings/organization/github");
    expect(screen.queryByRole("link", { name: "Connect GitHub" })).toBeNull();
  });

  it("tells team members who can configure repository access", () => {
    selectedTeamId = "team-a";
    reposData.connected = false;
    renderPage();
    expect(screen.getByText(/Ask an organization admin to configure the GitHub App/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Connect GitHub" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Configure the GitHub App" })).toBeNull();
  });
});
