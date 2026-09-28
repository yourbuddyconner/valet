// @vitest-environment jsdom
/**
 * Memory doc pane (Task 6 brief): badges derived from frontmatter + the
 * tree entry, frontmatter never shown raw, and the "Ask {name} to update
 * this" footer seeds the composer-prefill store before navigating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { ApiError, api, type OwnerFilter } from "~/api/client";
import { useComposerPrefillStore } from "~/stores/composer-prefill";

const docMock = vi.fn();

vi.mock("~/lib/mermaid", () => ({
  renderMermaid: vi.fn().mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><text>Memory diagram</text></svg>'),
}));

vi.mock("~/api/memory", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/api/memory")>();
  return {
    ...original,
    useMemoryDoc: (path: string, owner?: OwnerFilter) => docMock(path, owner),
  };
});

vi.mock("~/api/workspace-runtime", () => ({
  useOrchestratorInfo: () => ({ data: { name: "Nova" } }),
}));

const downloadMock = vi.fn();
vi.mock("~/lib/download", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/lib/download")>();
  return {
    ...original,
    downloadTextFile: (...args: Parameters<typeof original.downloadTextFile>) => downloadMock(...args),
  };
});

import { MemoryDoc, memoryDocPrefillText } from "./memory-doc";

// The component uses react-query mutations now — every render needs a
// provider. Retries off so mutation errors surface synchronously.
function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const meFixture = {
  id: "user-me",
  email: "me@example.com",
  name: "Me",
  avatarUrl: null,
  role: "member" as const,
  orgId: "org1",
  orgRole: "member" as const,
  defaultModel: null,
  defaultReasoning: null,
  newThreadBehavior: "keep_current" as const,
};

const orgFixture = {
  id: "org1",
  name: "Org",
  createdAt: 0,
  features: { organizations: true, ssoTeamSync: false },
  ssoTeamGroups: [],
  allowPublicArtifacts: false,
  plugins: [],
  callerRole: "member" as const,
};

function renderedDoc(rendered: string) {
  return {
    kind: "file" as const,
    path: "preferences/style.md",
    rendered,
    file: {
      path: "preferences/style.md",
      title: "Writing style",
      content: "body",
      type: "preference",
      pinned: true,
      updatedAt: Date.now() - 60_000,
    },
  };
}

describe("MemoryDoc", () => {
  beforeEach(() => {
    docMock.mockReset();
    downloadMock.mockReset();
    useComposerPrefillStore.setState({ text: null });
  });

  it("renders title, frontmatter-derived badges, and body — never raw frontmatter", () => {
    const rendered =
      '---\n' +
      'type: "preference"\n' +
      'title: "Writing style"\n' +
      'tags: ["voice", "tone"]\n' +
      'timestamp: "2026-07-13T00:00:00.000Z"\n' +
      'valet:\n' +
      '  sensitivity: "shareable"\n' +
      '  origin: "user-stated"\n' +
      '---\n' +
      '\n' +
      'Keep it warm and direct.\n';

    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /Writing style/ })).toBeTruthy();
    expect(screen.getByText("preference")).toBeTruthy();
    expect(screen.getByText("voice")).toBeTruthy();
    expect(screen.getByText("tone")).toBeTruthy();
    expect(screen.getByText("shareable")).toBeTruthy();
    expect(screen.getByText("user-stated")).toBeTruthy();
    expect(screen.getByText("Keep it warm and direct.")).toBeTruthy();
    expect(screen.queryByText(/timestamp:/)).toBeNull();
    expect(screen.queryByText(/valet:/)).toBeNull();
  });

  it("renders a fenced Mermaid block in memory content", async () => {
    const rendered = '---\ntype: "note"\ntitle: "Flow"\n---\n\n```mermaid\ngraph TD\n  A-->B\n```\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });

    const { container } = renderWithClient(
      <MemoryDoc path="notes/flow.md" onNavigateToChat={vi.fn()} />,
    );

    await waitFor(() => expect(container.querySelector('img[alt="Mermaid diagram"]')).toBeTruthy());
  });

  /**
   * `pinned` is a boolean on the wire (`memory_files.pinned` is a Postgres
   * boolean). The reader tested `=== 1` against it, so the pin never
   * rendered — and this suite's own fixture said `pinned: 1`, which is why
   * the bug survived. These two cases pin the real contract.
   */
  it("marks a pinned file in the heading", () => {
    docMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: renderedDoc("body"),
      refetch: vi.fn(),
    });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /Writing style/ }).textContent).toContain("\ud83d\udccc");
  });

  it("leaves an unpinned file's heading unmarked", () => {
    const doc = renderedDoc("body");
    docMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { ...doc, file: { ...doc.file, pinned: false } },
      refetch: vi.fn(),
    });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /Writing style/ }).textContent).not.toContain("\ud83d\udccc");
  });

  it("omits the sensitivity/origin badges when absent from frontmatter", () => {
    const rendered = '---\ntype: "note"\ntitle: "Plain"\n---\n\nJust text.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    expect(screen.getByText("note")).toBeTruthy();
    expect(screen.queryByText("shareable")).toBeNull();
    expect(screen.queryByText("user-stated")).toBeNull();
  });

  it("shows an in-voice empty state on 404", () => {
    docMock.mockReturnValue({
      isLoading: false,
      error: new ApiError(404, "not found"),
      data: undefined,
      refetch: vi.fn(),
    });
    renderWithClient(<MemoryDoc path="journal/2026-07-13.md" onNavigateToChat={vi.fn()} />);
    expect(screen.getByText(/Start a thread in your personal workspace/)).toBeTruthy();
  });

  it("shows a retry affordance on a non-404 error", () => {
    const refetch = vi.fn();
    docMock.mockReturnValue({
      isLoading: false,
      error: new ApiError(500, "boom"),
      data: undefined,
      refetch,
    });
    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    screen.getByText("Retry").click();
    expect(refetch).toHaveBeenCalled();
  });

  it("seeds the composer-prefill store and navigates when 'Ask in your personal workspace to update this' is clicked", () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const onNavigateToChat = vi.fn();

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={onNavigateToChat} />);
    screen.getByText("Ask in your personal workspace to update this").click();

    expect(useComposerPrefillStore.getState().text).toBe(
      "Update memory file preferences/style.md: ",
    );
    expect(onNavigateToChat).toHaveBeenCalled();
  });

  it("edits: textarea seeds from stored content, save PUTs and exits edit mode", async () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const write = vi.spyOn(api, "writeMemoryDoc").mockResolvedValue({});

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Edit"));

    const textarea = screen.getByLabelText("Memory content") as HTMLTextAreaElement;
    expect(textarea.value).toBe("body"); // file.content, not the rendered doc
    fireEvent.change(textarea, { target: { value: "new body" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({ path: "preferences/style.md", content: "new body" }, undefined),
    );
    await waitFor(() => expect(screen.queryByLabelText("Memory content")).toBeNull());
    write.mockRestore();
  });

  it("save is disabled when the draft is empty (delete is the way to clear)", () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Memory content"), { target: { value: "  " } });
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("delete is confirm-gated and calls onDeleted after the DELETE succeeds", async () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const del = vi.spyOn(api, "deleteMemoryDoc").mockResolvedValue({});
    const onDeleted = vi.fn();

    renderWithClient(
      <MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} onDeleted={onDeleted} />,
    );
    fireEvent.click(screen.getByText("Delete"));
    expect(del).not.toHaveBeenCalled(); // first click only arms the confirm
    fireEvent.click(screen.getByText("Confirm delete"));

    await waitFor(() => expect(del).toHaveBeenCalledWith("preferences/style.md", undefined));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    del.mockRestore();
  });

  /** `PUT /api/memory` has always honoured `pinned`; the doc view had no
   * control for it, so a pin could only be set by the agent. The write
   * carries no `content`, which is what keeps the body untouched. */
  it("pins a file with a metadata-only write", async () => {
    const doc = renderedDoc("body");
    docMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { ...doc, file: { ...doc.file, pinned: false } },
      refetch: vi.fn(),
    });
    const write = vi.spyOn(api, "writeMemoryDoc").mockResolvedValue({});

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Pin"));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({ path: "preferences/style.md", pinned: true }, undefined),
    );
    write.mockRestore();
  });

  it("unpins a pinned file", async () => {
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc("body"), refetch: vi.fn() });
    const write = vi.spyOn(api, "writeMemoryDoc").mockResolvedValue({});

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Unpin"));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({ path: "preferences/style.md", pinned: false }, undefined),
    );
    write.mockRestore();
  });

  /** The memory corpus cross-references itself with relative paths. Those
   * used to open a new tab that went nowhere. */
  it("opens a cross-reference in place instead of a new tab", () => {
    const rendered = '---\ntype: "note"\n---\n\nSee [alice](../people/alice.md).\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const onOpenPath = vi.fn();

    renderWithClient(
      <MemoryDoc path="journal/2026-08-12.md" onNavigateToChat={vi.fn()} onOpenPath={onOpenPath} />,
    );

    const link = screen.getByText("alice").closest("a");
    if (!link) throw new Error("no anchor around the cross-reference");
    expect(link.target).toBe("");

    const cancel = (e: Event) => e.preventDefault();
    document.addEventListener("click", cancel);
    try {
      fireEvent.click(link, { button: 0 });
    } finally {
      document.removeEventListener("click", cancel);
    }
    expect(onOpenPath).toHaveBeenCalledWith("people/alice.md");
  });

  it("downloads the full document (frontmatter included) under the path basename", () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Download"));

    expect(downloadMock).toHaveBeenCalledWith("style.md", rendered, "text/markdown");
  });

  /** The share half of the artifacts design used to live only in the chat
   * memory-viewer dialog; the `/memory` page had no share affordance. It now
   * rides `MemoryDoc`'s action row, so both surfaces get it. */
  it("shares: the Share panel offers 'Create share link' and posts the share", async () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const me = vi.spyOn(api, "getMe").mockResolvedValue(meFixture);
    const list = vi.spyOn(api, "listArtifacts").mockResolvedValue({ artifacts: [] });
    const org = vi.spyOn(api, "getOrg").mockResolvedValue(orgFixture);
    const share = vi.spyOn(api, "shareArtifact").mockResolvedValue({
      id: "a1",
      path: "preferences/style.md",
      url: "https://valet.test/a/tok",
      visibility: "org",
      version: 1,
      updatedAt: Date.now(),
    });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    expect(list).not.toHaveBeenCalled(); // panel closed → no list request
    fireEvent.click(screen.getByText("Share"));

    // The create button renders disabled until the artifact list resolves.
    const create = await screen.findByRole("button", { name: "Create share link" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(share).toHaveBeenCalledWith({ path: "preferences/style.md" }));

    me.mockRestore();
    list.mockRestore();
    org.mockRestore();
    share.mockRestore();
  });

  /** An org admin's artifact list holds EVERY member's rows, and memory
   * paths are conventional, so a path-only match can land on a colleague's
   * artifact — Revoke would then kill the colleague's live link. The panel
   * must match on the sharer too. */
  it("shares: the panel shows the personal artifact despite team and colleague snapshots at the same path", async () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const me = vi.spyOn(api, "getMe").mockResolvedValue(meFixture);
    const org = vi.spyOn(api, "getOrg").mockResolvedValue(orgFixture);
    const list = vi.spyOn(api, "listArtifacts").mockResolvedValue({
      artifacts: [
        {
          ownerType: "team", id: "team-snapshot", path: "preferences/style.md",
          title: "Team copy", format: "markdown", icon: "", version: 1,
          sharedVersion: null, token: "team-token", url: "https://valet.test/a/team-token",
          visibility: "public", actorUserId: "user-me", revoked: false,
          createdAt: 0, updatedAt: 2,
        },
        {
          ownerType: "user",
          id: "a-colleague",
          path: "preferences/style.md",
          title: "Writing style",
          format: "markdown" as const,
          icon: "",
          version: 1,
          sharedVersion: null,
          token: "colleague-token",
          url: "https://valet.test/a/colleague-token",
          visibility: "org" as const,
          actorUserId: "user-colleague",
          revoked: false,
          createdAt: 0,
          updatedAt: 1,
        },
        {
          ownerType: "user",
          id: "a-mine",
          path: "preferences/style.md",
          title: "Writing style",
          format: "markdown" as const,
          icon: "",
          version: 1,
          sharedVersion: null,
          token: "mine-token",
          url: "https://valet.test/a/my-token",
          visibility: "org" as const,
          actorUserId: "user-me",
          revoked: false,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Share"));

    const input = (await screen.findByLabelText("Share link")) as HTMLInputElement;
    expect(input.value).toBe("https://valet.test/a/my-token");
    expect(screen.getByRole("switch", { name: "Allow anyone with the link" }).getAttribute("aria-checked")).toBe("false");

    me.mockRestore();
    org.mockRestore();
    list.mockRestore();
  });

  it("delete confirm can be cancelled without calling the API", () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const del = vi.spyOn(api, "deleteMemoryDoc").mockResolvedValue({});

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Confirm delete")).toBeNull();
    expect(del).not.toHaveBeenCalled();
    del.mockRestore();
  });
});

describe("MemoryDoc team scope (TKAI-262)", () => {
  const teamOwner = { ownerType: "team" as const, ownerId: "team_1" };

  function teamsFixture(callerRole: "admin" | "member" | null) {
    return {
      teams: [
        {
          id: "team_1",
          orgId: "org1",
          name: "Platform",
          origin: "local" as const,
          externalId: null,
          createdAt: 0,
          memberCount: 2,
          callerRole,
          defaultModel: null,
        },
      ],
    };
  }

  beforeEach(() => {
    docMock.mockReset();
  });

  it("threads the owner into the doc query", () => {
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc("body"), refetch: vi.fn() });
    const teams = vi.spyOn(api, "listTeams").mockResolvedValue(teamsFixture("member"));
    const org = vi.spyOn(api, "getOrg").mockResolvedValue(orgFixture);

    renderWithClient(
      <MemoryDoc path="notes/roadmap.md" owner={teamOwner} onNavigateToChat={vi.fn()} />,
    );
    expect(docMock).toHaveBeenCalledWith("notes/roadmap.md", teamOwner);

    teams.mockRestore();
    org.mockRestore();
  });

  /** Team writes need team-admin or org-admin authority (`authorizeOwner`);
   * sharing and the composer prefill are own-scope only. A plain member
   * gets a read-only view: Download stays, everything else goes. */
  it("hides Share, write actions, and the prefill footer from a plain team member", async () => {
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc("body"), refetch: vi.fn() });
    const teams = vi.spyOn(api, "listTeams").mockResolvedValue(teamsFixture("member"));
    const org = vi.spyOn(api, "getOrg").mockResolvedValue(orgFixture);

    renderWithClient(
      <MemoryDoc path="notes/roadmap.md" owner={teamOwner} onNavigateToChat={vi.fn()} />,
    );

    expect(screen.getByText("Download")).toBeTruthy();
    await waitFor(() => expect(teams).toHaveBeenCalled());
    expect(screen.queryByText("Share")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByText(/Ask .* to update this/)).toBeNull();

    teams.mockRestore();
    org.mockRestore();
  });

  /** Mutation invalidations use OWNERLESS keys: react-query matches key
   * prefixes, so `doc(path)`/`tree()` cover every owner variant — including
   * the ownerless copies the dashboard card and chat dialog cache. Owner-ful
   * keys match only their own variant; this pins the regression where a
   * scoped save left the ownerless copies stale. */
  it("a scoped save invalidates the ownerless doc/tree cache copies too", async () => {
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc("body"), refetch: vi.fn() });
    const teams = vi.spyOn(api, "listTeams").mockResolvedValue(teamsFixture("admin"));
    const org = vi.spyOn(api, "getOrg").mockResolvedValue(orgFixture);
    const write = vi.spyOn(api, "writeMemoryDoc").mockResolvedValue({});

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(["memory", "doc", "notes/roadmap.md"], { kind: "file" });
    client.setQueryData(["memory", "tree"], { entries: [] });

    render(
      <QueryClientProvider client={client}>
        <MemoryDoc path="notes/roadmap.md" owner={teamOwner} onNavigateToChat={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByText("Edit"));
    fireEvent.change(screen.getByLabelText("Memory content"), { target: { value: "new body" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(write).toHaveBeenCalled());

    await waitFor(() => {
      const ownerlessDoc = client.getQueryCache().find({ queryKey: ["memory", "doc", "notes/roadmap.md"], exact: true });
      const ownerlessTree = client.getQueryCache().find({ queryKey: ["memory", "tree"], exact: true });
      expect(ownerlessDoc?.state.isInvalidated).toBe(true);
      expect(ownerlessTree?.state.isInvalidated).toBe(true);
    });

    teams.mockRestore();
    org.mockRestore();
    write.mockRestore();
  });

  it("shows write actions to a team admin, and writes carry the team owner", async () => {
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc("body"), refetch: vi.fn() });
    const teams = vi.spyOn(api, "listTeams").mockResolvedValue(teamsFixture("admin"));
    const org = vi.spyOn(api, "getOrg").mockResolvedValue(orgFixture);
    const write = vi.spyOn(api, "writeMemoryDoc").mockResolvedValue({});

    renderWithClient(
      <MemoryDoc path="notes/roadmap.md" owner={teamOwner} onNavigateToChat={vi.fn()} />,
    );

    fireEvent.click(await screen.findByText("Unpin"));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({ path: "notes/roadmap.md", pinned: false }, teamOwner),
    );
    // Sharing stays own-scope even for an admin — mem_share refuses team
    // paths in v1, and the web surface follows the same rule.
    expect(screen.queryByText("Share")).toBeNull();

    teams.mockRestore();
    org.mockRestore();
    write.mockRestore();
  });
});

describe("MemoryDoc resource lifetime", () => {
  const personal: OwnerFilter = { ownerType: "user", ownerId: "owner-a" };
  const transitions: { name: string; path: string; owner: OwnerFilter; from?: OwnerFilter }[] = [
    { name: "path", path: "notes/other.md", owner: personal },
    { name: "owner ID", path: "notes/source.md", owner: { ownerType: "user", ownerId: "owner-b" } },
    { name: "team owner", path: "notes/source.md", from: { ownerType: "team", ownerId: "team-a" }, owner: { ownerType: "team", ownerId: "team-b" } },
    { name: "owner type", path: "notes/source.md", owner: { ownerType: "team", ownerId: "owner-a" } },
  ];
  beforeEach(() => {
    docMock.mockImplementation((path: string, owner?: OwnerFilter) => ({
      isLoading: false, error: null,
      data: { ...renderedDoc("body"), file: { ...renderedDoc("body").file,
        path, title: path, content: `${owner?.ownerId}:${path}` } },
    }));
    vi.spyOn(api, "listTeams").mockResolvedValue({ teams: [] });
    vi.spyOn(api, "getOrg").mockResolvedValue({ ...orgFixture, callerRole: "admin" });
  });
  afterEach(() => vi.restoreAllMocks());

  function mount(startingOwner = personal) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const onDeleted = vi.fn();
    const pane = (path = "notes/source.md", owner = startingOwner) => (
      <QueryClientProvider client={client}>
        <MemoryDoc path={path} owner={owner} onNavigateToChat={vi.fn()} onDeleted={onDeleted} />
      </QueryClientProvider>
    );
    const view = render(pane());
    return { ...view, pane, client, onDeleted };
  }

  it.each(transitions)("drops the old draft when $name changes", async ({ path, owner, from }) => {
    const write = vi.spyOn(api, "writeMemoryDoc").mockResolvedValue({});
    const view = mount(from);
    fireEvent.click(await screen.findByText("Edit"));
    fireEvent.change(screen.getByLabelText("Memory content"), { target: { value: "Private draft for the old file" } });
    view.rerender(view.pane(path, owner));
    expect(screen.queryByLabelText("Memory content")).toBeNull();
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText("Edit"));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Memory content" }).value).toBe(`${owner.ownerId}:${path}`);
  });

  it.each(transitions)("drops the delete confirmation when $name changes", async ({ path, owner, from }) => {
    const remove = vi.spyOn(api, "deleteMemoryDoc").mockResolvedValue({});
    const view = mount(from);
    fireEvent.click(await screen.findByText("Delete"));
    view.rerender(view.pane(path, owner));
    await screen.findByText("Delete");
    expect(screen.queryByText("Confirm delete")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(transitions)("keeps old delete completion from navigating after $name changes", async ({ path, owner, from }) => {
    let finishDelete = () => {};
    const pending = new Promise<void>((resolve) => { finishDelete = resolve; });
    const remove = vi.spyOn(api, "deleteMemoryDoc").mockImplementation(async () => { await pending; return {}; });
    const view = mount(from);
    const invalidate = vi.spyOn(view.client, "invalidateQueries");
    fireEvent.click(await screen.findByText("Delete"));
    fireEvent.click(screen.getByText("Confirm delete"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("notes/source.md", from ?? personal));
    view.rerender(view.pane(path, owner));
    await act(async () => { finishDelete(); await pending; });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memory", "tree"] }));
    expect(view.onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("heading").textContent).toContain(path);
  });

  it("preserves the draft when an equivalent owner object is rendered again", () => {
    const view = mount();
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Memory content"), { target: { value: "Keep this draft" } });
    view.rerender(view.pane("notes/source.md", { ...personal }));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Memory content" }).value).toBe("Keep this draft");
  });
});

describe("memoryDocPrefillText", () => {
  it("formats the update-file prefill", () => {
    expect(memoryDocPrefillText("journal/2026-07-13.md")).toBe(
      "Update memory file journal/2026-07-13.md: ",
    );
  });
});
