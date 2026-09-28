// @vitest-environment jsdom
/**
 * A workspace-scoped events query that cannot name its owner yet is HELD —
 * `EventFeed` and `SubscriptionsPanel` both do it, because an owner-less
 * REQUEST is the org-wide one. A query that is unscoped on purpose sends no
 * owner either: the feed's "All" state, and the redeliver dialog's org-wide
 * subscription count. These cases pin that the two do not share a cache
 * entry, because a held query would otherwise show the org's rows under a
 * label reading "This workspace".
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListEventDropsResponse, ListEventsResponse, ListEventSubscriptionsResponse } from "@valet/api/wire";

// Every case here holds its query, so no request should be made. The mock
// keeps a missed hold from reaching the network instead of failing loudly.
const listEvents = vi.fn();
const listEventReceipts = vi.fn().mockResolvedValue({ receipts: [], nextCursor: null, lastReceiptAt: null, retentionDays: 7 });
const listEventDrops = vi.fn<() => Promise<ListEventDropsResponse>>(() =>
  Promise.resolve({ drops: [], nextCursor: null, previousCursor: null, lastEventAt: null }),
);
const listEventSubscriptions = vi.fn();
vi.mock("./client", () => ({
  api: {
    listEvents: () => listEvents(),
    listEventReceipts: () => listEventReceipts(),
    listEventDrops: () => listEventDrops(),
    listEventSubscriptions: () => listEventSubscriptions(),
  },
}));

import { eventDropsRefetchInterval, qkEvents, useEventReceipts, useEvents, useEventSubscriptions } from "./events";

/** What a warm org-wide entry holds — the rows a held query must not show. */
const ORG_FEED: ListEventsResponse = {
  events: [
    {
      id: "ev_1",
      service: "github",
      eventKey: "github.push",
      summary: "a colleague's push",
      refs: {},
      actor: null,
      occurredAt: 1,
      receivedAt: 1,
    },
  ],
};

const ORG_SUBSCRIPTIONS: ListEventSubscriptionsResponse = {
  subscriptions: [
    {
      id: "sub_1",
      name: "a colleague's rule",
      ownerType: "user",
      ownerId: "someone",
      eventKeys: ["github.push"],
      filters: [],
      target: { kind: "orchestrator" },
      enabled: true,
      createdBy: "someone",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("held events queries", () => {
  it("does not read the All entry while the feed's owner is unresolved", () => {
    const client = newClient();
    client.setQueryData(qkEvents.feed(), ORG_FEED);

    const { result } = renderHook(() => useEvents({}, undefined, { enabled: false }), {
      wrapper: makeWrapper(client),
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isPending).toBe(true);
    expect(listEvents).not.toHaveBeenCalled();
  });

  // `redeliver-button.tsx` reads this entry on purpose: redelivery fans out
  // to every matching subscription in the org, so its count is the org's.
  it("does not read the org-wide entry while the list's owner is unresolved", () => {
    const client = newClient();
    client.setQueryData(qkEvents.subscriptions(), ORG_SUBSCRIPTIONS);

    const { result } = renderHook(() => useEventSubscriptions(undefined, { enabled: false }), {
      wrapper: makeWrapper(client),
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isPending).toBe(true);
    expect(listEventSubscriptions).not.toHaveBeenCalled();
  });
});

describe("Problems polling", () => {
  it("polls unfiltered Problems", () => {
    expect(eventDropsRefetchInterval()).toBe(30_000);
  });

  it("does not poll a non-empty Problems search", () => {
    expect(eventDropsRefetchInterval("signature")).toBe(false);
  });
});

describe("qkEvents", () => {
  it("puts the owner last, so the bare prefix reaches every workspace", () => {
    expect(qkEvents.subscriptions({ ownerType: "team", ownerId: "t_eng" })).toEqual([
      "events",
      "subscriptions",
      "team",
      "t_eng",
    ]);
    expect(qkEvents.feed("github", "github.push", { ownerType: "user", ownerId: "u1" })).toEqual([
      "events",
      "feed",
      "github",
      "github.push",
      "user",
      "u1",
    ]);
  });

  // The three subscription mutations invalidate the bare prefix (small-fixes
  // design, deviation 2), so a held entry has to sit under it as well.
  it("keeps a held key under that same prefix", () => {
    const bare = [...qkEvents.subscriptions()];
    const held = [...qkEvents.subscriptions(undefined, true)];

    expect(held).not.toEqual(bare);
    expect(held.slice(0, bare.length)).toEqual(bare);
  });
});

it("does not request receipts without admin permission or a resolved org", () => {
  listEventReceipts.mockClear();
  const wrapper = makeWrapper(newClient());
  renderHook(() => useEventReceipts("org", {}, false), { wrapper });
  renderHook(() => useEventReceipts(undefined, {}, true), { wrapper });
  expect(listEventReceipts).not.toHaveBeenCalled();
});
