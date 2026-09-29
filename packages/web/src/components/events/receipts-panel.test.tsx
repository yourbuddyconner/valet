// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListEventReceiptsResponse } from "@valet/api/wire";
import { beforeEach, expect, it, vi } from "vitest";
import { ReceiptsPanel } from "./receipts-panel";
let role = "admin";
let pending = false;
let error: Error | null = null;
let data: ListEventReceiptsResponse | undefined;
const query = vi.fn();
const retry = vi.fn();
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { orgRole: role, orgId: "org-1" } }) }));
vi.mock("~/api/events", () => ({ useEventReceipts: (...args: unknown[]) => { query(...args); return { data, isPending: pending, isFetching: pending, error, refetch: retry }; } }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, params }: { children: ReactNode; params?: { eventId: string } }) => <a href={params ? `/events/${params.eventId}` : "/events?tab=problems"}>{children}</a> }));
const fixture: ListEventReceiptsResponse = {
  receipts: [{ id: "receipt-1", service: "slack", externalId: "Ev123", eventKey: "slack.message", eventId: "event-1",
    metadata: { channelId: "C123", botIdentityAvailable: false, payloadBytes: 80 },
    stages: [{ stage: "classification", outcome: "accepted", detail: "Message classified", at: 2000 }, { stage: "receipt", outcome: "received", detail: "Webhook recorded", at: 1000 }],
    subscriptions: [{ id: "sub-1", name: "Team alerts", ownerType: "team", ownerId: "team-1", target: "orchestrator:team", outcome: "filter_excluded" }], createdAt: 1000, updatedAt: 2000 }],
  nextCursor: "page-2", lastReceiptAt: 1000, retentionDays: 7,
};
beforeEach(() => { role = "admin"; pending = false; error = null; data = fixture; vi.clearAllMocks(); });

it("shows readable receipt details, ordered stages, decisions, and matched-event link", () => {
  render(<ReceiptsPanel />);
  expect(screen.getByText(/Retained for up to 7 days or 10,000 receipts/)).toBeTruthy();
  const details = screen.getByText(/Slack ·/).closest("details")!;
  fireEvent.click(within(details).getByText(/Slack ·/));
  expect(within(details).getByText("Channel")).toBeTruthy();
  expect(within(details).getByText("C123")).toBeTruthy();
  expect(within(details).getByText("No")).toBeTruthy();
  expect(within(details).getByText("Team alerts: Excluded by filters")).toBeTruthy();
  expect(within(details).getByRole("link").getAttribute("href")).toBe("/events/event-1");
  const stages = within(within(details).getByRole("region", { name: "Processing timeline" })).getAllByRole("listitem");
  expect(stages[0]?.textContent).toContain("Webhook recorded");
  expect(stages[1]?.textContent).toContain("Message classified");
  expect(details.querySelector('time[datetime="1970-01-01T00:00:01.000Z"]')).toBeTruthy();
});

it("disables the request for nonadmins and hides even cached receipts", () => {
  role = "member";
  render(<ReceiptsPanel />);
  expect(query).toHaveBeenCalledWith("org-1", expect.anything(), false);
  expect(screen.queryByText(/Slack ·/)).toBeNull();
  expect(screen.getByText(/organization administrators/)).toBeTruthy();
});

it("shows loading and empty states", () => {
  data = undefined; pending = true;
  const view = render(<ReceiptsPanel />);
  expect(screen.getByText("Loading incoming events…")).toBeTruthy();
  pending = false; data = { ...fixture, receipts: [], nextCursor: null };
  view.rerender(<ReceiptsPanel />);
  expect(screen.getByText(/No receipts recorded in the last 7 days/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
});

it("suppresses cached rows on failure and offers retry", () => {
  error = new Error("Forbidden");
  render(<ReceiptsPanel />);
  expect(screen.queryByText(/Slack ·/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("resets the page cursor when search changes and can page back", async () => {
  render(<ReceiptsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(query).toHaveBeenLastCalledWith("org-1", { q: "", cursor: "page-2", limit: 25 }, true);
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(query).toHaveBeenLastCalledWith("org-1", { q: "", cursor: undefined, limit: 25 }, true);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "C123" } });
  await waitFor(() => expect(query).toHaveBeenLastCalledWith("org-1", { q: "C123", cursor: undefined, limit: 25 }, true));
});

it("keeps filtering or failure visible when a later follow-up check completed", () => {
  data = { ...fixture, receipts: [{ ...fixture.receipts[0]!, stages: [
    { stage: "subscription_match", outcome: "filtered", detail: "Channel filter did not match", at: 2000 },
    { stage: "follow", outcome: "completed", detail: "Follow-up check finished", at: 3000 },
  ], subscriptions: [{ ...fixture.receipts[0]!.subscriptions[0]!, failedFilters: [{ field: "channel", op: "eq" }] }] } ] };
  const view = render(<ReceiptsPanel />);
  expect(screen.getByText("Excluded by subscription filters")).toBeTruthy();
  expect(screen.getByText(/Filters that did not match: channel/)).toBeTruthy();
  data = { ...data, receipts: [{ ...data.receipts[0]!, stages: [...data.receipts[0]!.stages, { stage: "dispatch", outcome: "failed", detail: "Delivery queue failed", at: 2500 }] }] };
  view.rerender(<ReceiptsPanel />);
  expect(screen.getByText("Failed")).toBeTruthy();
});

it("shows unfinished processing without declaring failure", () => {
  data = { ...fixture, receipts: [{ ...fixture.receipts[0]!, stages: [{ stage: "classification", outcome: "started", detail: "Classification started", at: 2000 }] }] };
  render(<ReceiptsPanel />);
  expect(screen.getByText("Started · no completion recorded")).toBeTruthy();
  fireEvent.click(screen.getByText("About this log"));
  expect(screen.getByText(/Check the rejections above/)).toBeTruthy();
});
