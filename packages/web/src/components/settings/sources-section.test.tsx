// @vitest-environment jsdom
/**
 * Organization · Sandbox images — unified sources page (sandbox-reconciliation
 * plan, Task 18). Mocks `~/api/sources` the same way `github-app-section.test.tsx`
 * mocks `~/api/settings` — these tests only care what the section renders and
 * which mutation it fires, not that TanStack Query resolves anything.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BakeSummary, ListBakesResponse, ListSourcesResponse, SourceSummary } from "~/api/sources";

const bakeMutate = vi.fn();
const patchMutate = vi.fn();
const deleteMutate = vi.fn();
const createMutate = vi.fn();

let sourcesData: ListSourcesResponse | undefined;
let bakesData: ListBakesResponse = { bakes: [] };
let sourcesLoading = false;
let sourcesError = false;

vi.mock("~/api/sources", () => ({
  useBakeQueue: () => ({ data: { builderAvailable: sourcesData?.builderAvailable ?? true, reorderAvailable: true, running: [], queued: [], recent: [], blocked: [] }, error: null, isLoading: false }),
  useReorderBakeQueue: () => ({ mutate: vi.fn(), isPending: false }),
  useSources: () => ({
    data: sourcesData,
    isLoading: sourcesLoading,
    error: sourcesError ? new Error("boom") : null,
  }),
  useSourceBakes: () => ({ data: bakesData, isLoading: false, error: null }),
  useCreateSource: () => ({ mutate: createMutate, isPending: false }),
  usePatchSource: () => ({ mutate: patchMutate, isPending: false }),
  useDeleteSource: () => ({ mutate: deleteMutate, isPending: false }),
  useBakeSource: () => ({ mutate: bakeMutate, isPending: false }),
}));

import { SourcesSection } from "./sources-section";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSource(overrides: Partial<SourceSummary> = {}): SourceSummary {
  return {
    id: "src_1",
    orgId: "org_1",
    kind: "repo",
    parentId: null,
    name: "acme/widgets",
    externalRef: null,
    pullSecretName: null,
    setupCommands: null,
    repoHost: "github",
    repoFullName: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    schedule: "nightly",
    enabled: true,
    lastBoundAt: Date.now(),
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeBake(overrides: Partial<BakeSummary> = {}): BakeSummary {
  return {
    id: "bake_1",
    sourceId: "src_1",
    identityHash: "hash1",
    commitSha: "abcdef1234567",
    imageRef: "registry.local/widgets:abcdef1",
    status: "pushed",
    builderBackend: "docker",
    error: null,
    logTail: null,
    startedAt: 1000,
    finishedAt: 2000,
    createdAt: 1000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SourcesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourcesData = { sources: [], builderAvailable: true };
    bakesData = { bakes: [] };
    sourcesLoading = false;
    sourcesError = false;
  });

  it("puts the bake queue before the base image settings", () => {
    render(<SourcesSection />);
    expect(screen.getAllByRole("heading")[0].textContent).toContain("Bake queue");
  });

  // ── Loading / error ──────────────────────────────────────────────────────

  it("shows a loading spinner while sources load", () => {
    sourcesLoading = true;
    sourcesData = undefined;
    render(<SourcesSection />);
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  });

  it("shows failure text on error", () => {
    sourcesError = true;
    sourcesData = undefined;
    render(<SourcesSection />);
    expect(screen.getByText("Failed to load image sources. Reload the page.")).toBeTruthy();
  });

  // ── Builder-unavailable banner ────────────────────────────────────────────

  it("shows the builder-unavailable banner when builderAvailable is false", () => {
    sourcesData = { sources: [], builderAvailable: false };
    render(<SourcesSection />);
    expect(
      screen.getByText(/Image builds are unavailable/),
    ).toBeTruthy();
  });

  it("does not show the banner when builderAvailable is true", () => {
    sourcesData = { sources: [], builderAvailable: true };
    render(<SourcesSection />);
    expect(
      screen.queryByText(/Image builds are unavailable/),
    ).toBeNull();
  });

  // ── Base image card ───────────────────────────────────────────────────────

  it("base card: Save with no base source fires createSource (POST) with commands split on newline", async () => {
    sourcesData = { sources: [], builderAvailable: true };
    render(<SourcesSection />);

    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Setup commands");
    await user.type(textarea, "apt-get update\napt-get install -y git");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        {
          kind: "base",
          name: "Base",
          setupCommands: ["apt-get update", "apt-get install -y git"],
        },
        expect.anything(),
      ),
    );
  });

  it("base card: Save with an existing base source fires patchSource (PATCH)", async () => {
    const base = makeSource({
      id: "base_1",
      kind: "base",
      repoFullName: null,
      repoHost: null,
      name: "Base",
      setupCommands: ["apt-get update"],
    });
    sourcesData = { sources: [base], builderAvailable: true };
    render(<SourcesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchMutate).toHaveBeenCalledWith(
        { id: "base_1", body: { setupCommands: ["apt-get update"] } },
        expect.anything(),
      ),
    );
  });

  it("base card: Bake now fires bakeSource with the base source id", async () => {
    const base = makeSource({
      id: "base_1",
      kind: "base",
      repoFullName: null,
      repoHost: null,
      name: "Base",
      setupCommands: ["apt-get update"],
    });
    sourcesData = { sources: [base], builderAvailable: true };
    render(<SourcesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Bake now" }));

    await waitFor(() => expect(bakeMutate).toHaveBeenCalledWith("base_1", expect.anything()));
  });

  it("base card: pre-fills textarea from existing source setupCommands", () => {
    const base = makeSource({
      id: "base_1",
      kind: "base",
      repoFullName: null,
      repoHost: null,
      name: "Base",
      setupCommands: ["pip install uv", "npm install -g pnpm"],
    });
    sourcesData = { sources: [base], builderAvailable: true };
    render(<SourcesSection />);

    const textarea = screen.getByLabelText("Setup commands") as HTMLTextAreaElement;
    expect(textarea.value).toBe("pip install uv\nnpm install -g pnpm");
  });

  // ── Repository images ─────────────────────────────────────────────────────

  it("repo section shows empty-state copy when no repo sources exist", () => {
    sourcesData = { sources: [], builderAvailable: true };
    render(<SourcesSection />);
    expect(
      screen.getByText("Repository images appear automatically when a runtime binds a repo."),
    ).toBeTruthy();
  });

  it("repo row: shows repo name, status pill, and enabled switch", () => {
    const repo = makeSource({ id: "src_repo_1", kind: "repo", repoFullName: "acme/widgets" });
    sourcesData = { sources: [repo], builderAvailable: true };
    render(<SourcesSection />);

    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(screen.getByText("Status unavailable")).toBeTruthy();
    expect(screen.getByLabelText("Enable bakes for acme/widgets")).toBeTruthy();
  });

  it("repo row: keeps resource controls enabled when image builds are unavailable", () => {
    const repo = makeSource({ id: "src_repo_1", kind: "repo", repoFullName: "acme/widgets" });
    sourcesData = { sources: [repo], builderAvailable: false };
    render(<SourcesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Details for acme/widgets" }));
    expect((screen.getByLabelText("CPU cores for acme/widgets") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Memory for acme/widgets") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save resources" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Bake now" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Details for acme/widgets" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("repo row: toggling the enabled switch PATCHes the source", () => {
    const repo = makeSource({ id: "src_repo_1", kind: "repo", enabled: true });
    sourcesData = { sources: [repo], builderAvailable: true };
    render(<SourcesSection />);

    fireEvent.click(screen.getByLabelText("Enable bakes for acme/widgets"));

    expect(patchMutate).toHaveBeenCalledWith(
      { id: "src_repo_1", body: { enabled: false } },
    );
  });

  it("decayed repo row: shows paused copy when disabled and lastBoundAt > 30 days ago", () => {
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const repo = makeSource({
      id: "src_repo_1",
      kind: "repo",
      enabled: false,
      lastBoundAt: thirtyOneDaysAgo,
    });
    sourcesData = { sources: [repo], builderAvailable: true };
    render(<SourcesSection />);

    expect(screen.getByText("paused — repo unused")).toBeTruthy();
  });

  it("active repo row: does not show paused copy when recently used", () => {
    const repo = makeSource({
      id: "src_repo_1",
      kind: "repo",
      enabled: false,
      lastBoundAt: Date.now(),
    });
    sourcesData = { sources: [repo], builderAvailable: true };
    render(<SourcesSection />);

    expect(screen.queryByText("paused — repo unused")).toBeNull();
  });

  it("repo row: bake history toggle shows bakes table with status and commit", async () => {
    const repo = makeSource({ id: "src_repo_1", kind: "repo" });
    sourcesData = { sources: [repo], builderAvailable: true };
    bakesData = {
      bakes: [makeBake({ id: "bake_1", status: "pushed", commitSha: "abcdef1234567" })],
    };
    render(<SourcesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Details for acme/widgets" }));

    await waitFor(() => expect(screen.getAllByText("pushed").length).toBeGreaterThan(0));
    expect(screen.getByText("abcdef1")).toBeTruthy();
  });

  it("keeps resources and history collapsed together and preserves resource edits", () => {
    sourcesData = { sources: [makeSource()], builderAvailable: true };
    render(<SourcesSection />);
    expect(screen.queryByLabelText("CPU cores for acme/widgets")).toBeNull();
    expect(screen.queryByText("No bakes yet.")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Details for acme/widgets" });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("CPU cores for acme/widgets"), { target: { value: "4" } });
    expect(screen.getByText("Sandbox history")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Save resources" })).toBeNull();
    fireEvent.click(toggle);
    expect((screen.getByLabelText("CPU cores for acme/widgets") as HTMLInputElement).value).toBe("4");
  });

  it("preserves resource drafts and expanded details when search hides a repository", () => {
    sourcesData = { sources: [makeSource()], builderAvailable: true };
    render(<SourcesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Details for acme/widgets" }));
    fireEvent.change(screen.getByLabelText("CPU cores for acme/widgets"), { target: { value: "4" } });
    const search = screen.getByRole("searchbox", { name: "Search repositories" });
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.queryByRole("button", { name: "Save resources" })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Details for acme/widgets" }).getAttribute("aria-expanded")).toBe("true");
    expect((screen.getByLabelText("CPU cores for acme/widgets") as HTMLInputElement).value).toBe("4");
  });

  it("searches repository names without case or surrounding whitespace and clears no matches", () => {
    sourcesData = { sources: [makeSource(), makeSource({ id: "other", repoFullName: "acme/api" })], builderAvailable: true };
    render(<SourcesSection />);
    const search = screen.getByRole("searchbox", { name: "Search repositories" });
    fireEvent.change(search, { target: { value: " WIDGET " } });
    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Details for acme/api" })).toBeNull();
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("No repositories match your search.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("acme/api")).toBeTruthy();
  });

  it("sorts repository rows by name and recent use", async () => {
    sourcesData = { sources: [makeSource({ lastBoundAt: 2000 }), makeSource({ id: "other", repoFullName: "acme/api", lastBoundAt: 1000 })], builderAvailable: true };
    render(<SourcesSection />);
    const names = () => screen.getAllByRole("button", { name: /^Details for / }).map((button) => button.getAttribute("aria-label"));
    expect(names()).toEqual(["Details for acme/api", "Details for acme/widgets"]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Sort: Name/ }));
    await user.click(screen.getByRole("menuitem", { name: "Recently used" }));
    expect(names()).toEqual(["Details for acme/widgets", "Details for acme/api"]);
  });

  it("updates collapsed status after a refresh and sorts active builds first", async () => {
    sourcesData = { sources: [makeSource({ latestBake: { status: "pushed", createdAt: 1 } }), makeSource({ id: "other", repoFullName: "acme/zebra", latestBake: { status: "building", createdAt: 2 } })], builderAvailable: true };
    const { rerender } = render(<SourcesSection />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Sort: Name/ }));
    await user.click(screen.getByRole("menuitem", { name: "Build status" }));
    expect(screen.getAllByRole("button", { name: /^Details for / })[0].getAttribute("aria-label")).toBe("Details for acme/zebra");
    sourcesData = { sources: [makeSource({ latestBake: null })], builderAvailable: true };
    rerender(<SourcesSection />);
    expect(screen.getByText("Not built")).toBeTruthy();
    expect(screen.queryByText("Built")).toBeNull();
  });

  it.each([
    ["pushed", "Built"], ["building", "Building"], ["queued", "Build queued"], ["failed", "Build failed"],
  ] as const)("shows %s status while collapsed", (status, label) => {
    sourcesData = { sources: [makeSource({ latestBake: { status, createdAt: 1000 } })], builderAvailable: true };
    render(<SourcesSection />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText("Sandbox history")).toBeNull();
  });

  // ── External images ───────────────────────────────────────────────────────

  it("external create form: Add fires createSource with name and externalRef", async () => {
    sourcesData = { sources: [], builderAvailable: true };
    render(<SourcesSection />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add external image" }));
    await user.type(screen.getByLabelText("Name"), "Node 22");
    await user.type(screen.getByLabelText("Image ref"), "registry.example.com/base:node22");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        {
          kind: "external",
          name: "Node 22",
          externalRef: "registry.example.com/base:node22",
          pullSecretName: undefined,
        },
        expect.anything(),
      ),
    );
  });

  it("external row: lists name, ref, and pull secret badge", () => {
    const ext = makeSource({
      id: "img_1",
      kind: "external",
      name: "Node 22",
      externalRef: "registry.example.com/base:node22",
      pullSecretName: "regcred",
      repoFullName: null,
    });
    sourcesData = { sources: [ext], builderAvailable: true };
    render(<SourcesSection />);

    expect(screen.getByText("Node 22")).toBeTruthy();
    expect(screen.getByText("registry.example.com/base:node22")).toBeTruthy();
    expect(screen.getByText("regcred")).toBeTruthy();
  });

  it("external row: Delete button opens confirmation, then fires deleteSource", async () => {
    const ext = makeSource({
      id: "img_1",
      kind: "external",
      name: "Node 22",
      externalRef: "registry.example.com/base:node22",
      pullSecretName: null,
      repoFullName: null,
    });
    sourcesData = { sources: [ext], builderAvailable: true };
    render(<SourcesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Delete Node 22" }));

    const confirmBtn = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith("img_1", expect.anything()));
  });
});
