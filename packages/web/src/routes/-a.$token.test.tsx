// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GetArtifactResponse } from "@valet/api/wire";
import { api } from "~/api/client";
import { ArtifactPage } from "./a.$token";
let token = "published-token";
const doc: GetArtifactResponse = {
  title: "Published report", content: "Report source", rendered: "<h1>Report</h1>", format: "html", description: "A report",
  icon: "", version: 1, visibility: "public", ownerType: "user", updatedAt: 1, canComment: false,
};
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => () => ({ useParams: () => ({ token }) }) }));
vi.mock("~/api/client", async importOriginal => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return { ...actual, api: { ...actual.api, getArtifact: vi.fn(), revokeArtifact: vi.fn() } };
});
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: undefined, error: null }) }));
vi.mock("~/components/artifact/artifact-frame", () => ({ ArtifactFrame: () => <div>Artifact content</div> }));
vi.mock("~/components/artifact/artifact-comments", () => ({ ArtifactPins: () => null, ArtifactThreadPanel: () => null, CommentComposer: () => null, groupThreads: () => [] }));
vi.mock("~/lib/use-theme-attribute", () => ({ useThemeAttribute: () => "light" }));
beforeEach(() => {
  vi.clearAllMocks(); token = "published-token";
  vi.mocked(api.getArtifact).mockResolvedValue(doc);
  vi.mocked(api.revokeArtifact).mockResolvedValue({ ok: true });
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ArtifactPage /></QueryClientProvider>);
}
it("keeps public and non-manager readers read-only", async () => {
  setup();
  expect(await screen.findByText("Artifact content")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(api.revokeArtifact).not.toHaveBeenCalled();
});
it("requires confirmation before revoking the granted artifact and hides the reader after success", async () => {
  vi.mocked(api.getArtifact).mockResolvedValue({ ...doc, management: { id: "artifact-id" } });
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  const dialog = screen.getByRole("dialog", { name: "Revoke the link to Published report?" });
  expect(api.revokeArtifact).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(api.revokeArtifact).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(api.revokeArtifact).toHaveBeenCalledWith("artifact-id"));
  expect(await screen.findByText("This link is revoked.")).toBeTruthy();
  expect(screen.queryByText("Artifact content")).toBeNull();
});
it("keeps a failed revoke visible and allows retry", async () => {
  vi.mocked(api.getArtifact).mockResolvedValue({ ...doc, management: { id: "artifact-id" } });
  vi.mocked(api.revokeArtifact).mockRejectedValueOnce(new Error("Access denied"));
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
  expect(await screen.findByText(/Could not revoke this link/)).toBeTruthy();
  expect(screen.getByText("Artifact content")).toBeTruthy();
  expect(screen.queryByText("This link is revoked.")).toBeNull();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
  expect(await screen.findByText("This link is revoked.")).toBeTruthy();
});
it("does not carry a revoke dialog or revoked state to another token", async () => {
  vi.mocked(api.getArtifact).mockResolvedValue({ ...doc, management: { id: "artifact-id" } });
  const view = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
  await screen.findByText("This link is revoked.");
  token = "other-token";
  vi.mocked(api.getArtifact).mockResolvedValue(doc);
  view.rerender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ArtifactPage /></QueryClientProvider>);
  expect(await screen.findByText("Artifact content")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
});
