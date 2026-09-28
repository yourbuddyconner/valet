// @vitest-environment jsdom
/**
 * Workspace-scoped artifact gallery. The list uses stored ownership and
 * resets the cursor before requesting a different workspace.
 *
 * Revoke confirms in a `ConfirmDialog`, not `window.confirm`: a native
 * confirm is auto-accepted by browser automation, so an agent driving this
 * page revoked a link with one click and no confirm step at all. The tests
 * below hold that line — the click must only OPEN the dialog.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { OwnerFilter } from "~/api/client";
import type { ArtifactListItem, ListArtifactsResponse } from "@valet/api/wire";

const mine: ArtifactListItem = {
  ownerType: "user",
  id: "art_mine",
  path: "artifacts/report.md",
  title: "Deploy report",
  format: "markdown",
  icon: "📄",
  version: 1,
  sharedVersion: null,
  token: "tok-mine",
  url: "https://valet.example/a/tok-mine",
  visibility: "org",
  actorUserId: "u-1",
  revoked: false,
  createdAt: 1,
  updatedAt: 2,
};

const second: ArtifactListItem = {
  ...mine,
  id: "art_second",
  title: "Launch notes",
  token: "tok-second",
  url: "https://valet.example/a/tok-second",
};

const revoked: ArtifactListItem = {
  ...mine,
  id: "art_revoked",
  title: "Old page",
  token: "tok-revoked",
  url: "https://valet.example/a/tok-revoked",
  revoked: true,
};

let artifactsData: ListArtifactsResponse = { artifacts: [mine, revoked] };

const revokeMutate = vi.fn();
let revokePending = false;
let revokeError: Error | null = null;
const useArtifactsMock = vi.fn();
let owner: OwnerFilter | undefined = { ownerType: "user", ownerId: "u-1" };
let listError: Error | null = null;
let listLoading = false;
let orgRole = "member";
let identityError: Error | null = null;
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ error: identityError, data: { id: "u-1", orgRole } }) }));

vi.mock("@tanstack/react-router", () => ({
  // `params` is spread as a real prop (an object), not through `...rest`,
  // so the row's token is readable off the rendered anchor as a plain data
  // attribute instead of stringifying to "[object Object]".
  Link: ({
    children,
    params,
    ...rest
  }: {
    children: ReactNode;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => (
    <a {...rest} data-token={params?.token}>
      {children}
    </a>
  ),
}));

vi.mock("~/api/artifacts", () => ({
  useArtifacts: (...args: unknown[]) => {
    useArtifactsMock(...args);
    return { data: artifactsData, isLoading: listLoading, error: listError };
  },
  useRevokeArtifact: () => ({
    mutate: revokeMutate,
    isPending: revokePending,
    error: revokeError,
    // A real reset CLEARS the error. A bare vi.fn() would let a reset that is
    // never called pass this suite.
    reset: () => {
      revokeError = null;
    },
  }),
}));

import { WorkspaceArtifactGallery } from "./workspace-artifact-gallery";

function renderPage() {
  return render(<WorkspaceArtifactGallery />);
}

/** The row controls, in list order. The dialog's confirm button carries the
 * same label, so grab these before opening anything. */
function rowRevokeButtons() {
  return screen.getAllByRole("button", { name: "Revoke" });
}

function openDialog(index = 0) {
  fireEvent.click(rowRevokeButtons()[index]!);
  return screen.getByRole("dialog");
}

beforeEach(() => {
  artifactsData = { artifacts: [mine, revoked] };
  owner = { ownerType: "user", ownerId: "u-1" };
  listError = null;
  listLoading = false;
  identityError = null;
  orgRole = "member";
  revokePending = false;
  revokeError = null;
  revokeMutate.mockReset();
  useArtifactsMock.mockClear();
});

describe("WorkspaceArtifactGallery", () => {
  it("requests the personal owner rather than the publishing actor", () => {
    renderPage();
    expect(useArtifactsMock).toHaveBeenCalledWith(owner, { limit: 50, cursor: undefined });
  });

  it("resets pagination on personal, team, and team-to-team switches", () => {
    artifactsData = { artifacts: [mine], nextCursor: "page-two" };
    const view = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(useArtifactsMock).toHaveBeenLastCalledWith(owner, { limit: 50, cursor: "page-two" });
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(useArtifactsMock).toHaveBeenLastCalledWith(owner, { limit: 50, cursor: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    for (const nextOwner of [
      { ownerType: "team", ownerId: "team-1" },
      { ownerType: "team", ownerId: "team-2" },
      { ownerType: "user", ownerId: "u-1" },
    ] satisfies OwnerFilter[]) {
      useArtifactsMock.mockClear();
      owner = nextOwner;
      view.rerender(<WorkspaceArtifactGallery />);
      expect(useArtifactsMock).toHaveBeenCalledWith(owner, { limit: 50, cursor: undefined });
      expect(useArtifactsMock.mock.calls.every((call) => call[1].cursor === undefined)).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
  });

  it("does not request an unscoped list while identity is loading or failed", () => {
    owner = undefined;
    const view = renderPage();
    expect(screen.getByText("Loading artifacts…")).toBeTruthy();
    expect(useArtifactsMock).not.toHaveBeenCalled();
    identityError = new Error("offline");
    view.rerender(<WorkspaceArtifactGallery />);
    expect(screen.getByText(/Could not load your workspace/)).toBeTruthy();
    expect(useArtifactsMock).not.toHaveBeenCalled();
  });

  it("hides cached rows when access fails and shows a corrective error", () => {
    listError = new Error("owner not found");
    renderPage();
    expect(screen.getByText(/Check your access, then reload/)).toBeTruthy();
    expect(screen.queryByText("Deploy report")).toBeNull();
  });

  it("shows loading instead of old rows while a workspace loads", () => {
    listLoading = true;
    renderPage();
    expect(screen.getByText("Loading artifacts…")).toBeTruthy();
    expect(screen.queryByText("Deploy report")).toBeNull();
  });

  it("filters out revoked rows", () => {
    renderPage();
    expect(screen.getByText("Deploy report")).toBeTruthy();
    expect(screen.queryByText("Old page")).toBeNull();
  });

  it("shows the empty state when the workspace list is empty", () => {
    artifactsData = { artifacts: [revoked] };
    renderPage();
    expect(
      screen.getByText("Nothing published yet. Ask your agent to publish a page, or share a memory doc."),
    ).toBeTruthy();
  });

  it("links each row to /a/$token with the row's token", () => {
    renderPage();
    const link = screen.getByText("Deploy report").closest("a");
    expect(link?.getAttribute("to")).toBe("/a/$token");
    expect(link?.getAttribute("data-token")).toBe("tok-mine");
  });

  it("only opens the confirm dialog on the revoke click — it revokes nothing", () => {
    renderPage();
    expect(screen.queryByRole("dialog")).toBeNull();

    const dialog = openDialog();

    expect(revokeMutate).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Revoke the link to Deploy report?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Anyone who opens the link gets a 404, and the page leaves this gallery. Publish it again to get a new link.",
      ),
    ).toBeTruthy();
  });

  it("revokes nothing when the dialog is cancelled", async () => {
    renderPage();
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(revokeMutate).not.toHaveBeenCalled();
  });

  it("confirms per row: one row's dialog carries that row's artifact", async () => {
    artifactsData = { artifacts: [mine, second] };
    renderPage();
    expect(rowRevokeButtons()).toHaveLength(2);

    const dialog = openDialog(1);

    expect(within(dialog).getByText("Revoke the link to Launch notes?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(revokeMutate).toHaveBeenCalledTimes(1));
    expect(revokeMutate.mock.calls[0]![0]).toEqual({ id: "art_second" });
  });

  it("closes the dialog once the revoke succeeds", async () => {
    revokeMutate.mockImplementation(
      (_vars: { id: string }, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    );
    renderPage();
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a corrective error in the dialog and keeps the row when revoke fails", () => {
    // The failure has to ARRIVE while the dialog is open, the way production
    // produces it. Setting it before the open would test the stale-error path
    // the reopen case below forbids.
    const view = renderPage();
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    revokeError = new Error("network unreachable");
    view.rerender(<WorkspaceArtifactGallery />);

    expect(
      within(screen.getByRole("dialog")).getByText(
        "network unreachable. Check the server is running, then try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Deploy report")).toBeTruthy();
  });

  it("reopening after a failed revoke starts with no error", () => {
    // React Query holds `error` until the next mutate, so the row button
    // clears it as it opens the dialog.
    revokeError = new Error("network unreachable");
    renderPage();

    const dialog = openDialog();

    expect(within(dialog).queryByText(/network unreachable/)).toBeNull();
  });

  it("disables the row control and names the pending state while revoking", () => {
    revokePending = true;
    renderPage();
    const button = screen.getByRole("button", { name: "Revoking…" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});


it("shows colleague artifacts without offering unauthorized revoke", () => {
  owner = { ownerType: "team", ownerId: "team-a" };
  artifactsData = { artifacts: [{ ...mine, actorUserId: "colleague" }] };
  const view = renderPage();
  expect(screen.getByText("Deploy report")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  orgRole = "admin";
  view.rerender(<WorkspaceArtifactGallery />);
  expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
});

it("labels team rows and gallery as team-only even with a legacy public flag", () => {
  owner = { ownerType: "team", ownerId: "team-1" };
  artifactsData = { artifacts: [{ ...mine, ownerType: "team", visibility: "public", actorUserId: "other-member" }] };
  orgRole = "member";
  render(<WorkspaceArtifactGallery />);
  expect(screen.getByText("Team-only")).toBeTruthy();
  expect(screen.getByText("Team-only pages. Only current members of this team can open these links.")).toBeTruthy();
  expect(screen.queryByText("public")).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "Allow anyone with the link" })).toBeNull();
});
