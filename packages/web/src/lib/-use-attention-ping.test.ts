/**
 * The decision of WHEN to make a sound is the whole design here, so it
 * lives in pure functions and is tested directly. The rules being pinned:
 * only blocked-on-a-person kinds ping, an already-read item never does, and
 * a gate on the page you are looking at stays silent.
 */
import type { NotificationKind, NotificationSummary } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import {
  attentionSessionIds,
  hrefMatchesLocation,
  isActionable,
  shouldPing,
  titleWithCount,
  type PingContext,
} from "./use-attention-ping";

function notif(kind: NotificationKind, over: Partial<NotificationSummary> = {}): NotificationSummary {
  return {
    id: "n1",
    kind,
    urgency: "high",
    title: "Approve the deploy",
    createdAt: 1,
    ...over,
  };
}

const VISIBLE: PingContext = { pathname: "/sessions/abc", search: "", tabVisible: true };
const HIDDEN: PingContext = { pathname: "/sessions/abc", search: "", tabVisible: false };

describe("isActionable", () => {
  it("counts the kinds that block on a person", () => {
    expect(isActionable(notif("approval"))).toBe(true);
    expect(isActionable(notif("question"))).toBe(true);
    expect(isActionable(notif("escalation"))).toBe(true);
  });

  it("excludes a general update — it goes to the bell, not the speaker", () => {
    expect(isActionable(notif("notification"))).toBe(false);
  });

  it("excludes anything already read", () => {
    expect(isActionable(notif("approval", { readAt: 5 }))).toBe(false);
  });
});

describe("attentionSessionIds", () => {
  it("collects sessions with an unread actionable notification", () => {
    const out = attentionSessionIds([
      notif("approval", { sessionId: "s1" }),
      notif("notification", { id: "n2", sessionId: "s2" }),
      notif("question", { id: "n3", readAt: 5, sessionId: "s3" }),
    ]);
    expect(out).toEqual(new Set(["s1"]));
  });

  it("lights a live session from its pending gate before any poll arrives", () => {
    // The gate frame reaches the stream store the moment the gate opens;
    // the notification row shows up on the next 30s poll. The dot must not
    // wait for the poll (TKAI-257).
    expect(attentionSessionIds([], { s1: true })).toEqual(new Set(["s1"]));
  });

  it("clears a live session the moment its gates resolve, unread notification or not", () => {
    // Resolving a gate does not mark its notification read, so the poll
    // keeps listing the session until the user opens the bell. The live
    // store says the gate is gone — believe it.
    const out = attentionSessionIds([notif("approval", { sessionId: "s1" })], { s1: false });
    expect(out).toEqual(new Set());
  });

  it("keeps an escalation lit even when the live session has no gates", () => {
    // A stuck submission has no decision gate behind it, so the stream
    // store never sees it. Only the poll can clear it.
    const out = attentionSessionIds([notif("escalation", { sessionId: "s1" })], { s1: false });
    expect(out).toEqual(new Set(["s1"]));
  });

  it("falls back to the poll for a session with no open socket", () => {
    // No key in the live map = no WS. Its slice may be missing or stale;
    // the poll is the only truth available.
    const out = attentionSessionIds([notif("approval", { sessionId: "s1" })], {});
    expect(out).toEqual(new Set(["s1"]));
  });
});

describe("shouldPing", () => {
  it("stays silent for a general update", () => {
    expect(shouldPing(notif("notification"), HIDDEN)).toBe(false);
  });

  it("pings when the tab is hidden, wherever the gate points", () => {
    expect(shouldPing(notif("approval", { href: "/sessions/abc" }), HIDDEN)).toBe(true);
  });

  it("stays silent when you are already looking at the page it points to", () => {
    // The decision card is on screen. A sound adds nothing you cannot see.
    expect(shouldPing(notif("approval", { href: "/sessions/abc" }), VISIBLE)).toBe(false);
  });

  it("pings when you are visible but somewhere else in the app", () => {
    expect(shouldPing(notif("approval", { href: "/sessions/other" }), VISIBLE)).toBe(true);
  });

  it("pings when the notification has no link to compare", () => {
    expect(shouldPing(notif("escalation"), VISIBLE)).toBe(true);
  });
});

describe("hrefMatchesLocation", () => {
  it("requires the notification thread to be on screen", () => {
    expect(hrefMatchesLocation("/chat?thread=t1", "/chat", "")).toBe(false);
    expect(hrefMatchesLocation("/chat", "/chat", "")).toBe(true);
  });

  it("does not match a different path", () => {
    expect(hrefMatchesLocation("/sessions/a", "/sessions/b", "")).toBe(false);
  });

  /**
   * Every assistant conversation lives at `/chat`, so the path alone cannot
   * say which one is open. Comparing paths only made a gate raised by any
   * OTHER assistant silent while the reader sat on `/chat` — the case this
   * whole feature exists to catch.
   */
  it("does not match another workspace at the same path", () => {
    expect(hrefMatchesLocation("/chat?workspace=b", "/chat", "?workspace=a")).toBe(false);
  });

  it("matches the workspace actually open", () => {
    expect(hrefMatchesLocation("/chat?workspace=a", "/chat", "?workspace=a")).toBe(true);
    // The leading `?` is optional — routers report it both ways.
    expect(hrefMatchesLocation("/chat?workspace=a", "/chat", "workspace=a")).toBe(true);
  });

  it("does not match an unresolved workspace", () => {
    expect(hrefMatchesLocation("/chat?workspace=b", "/chat", "")).toBe(false);
  });

  it("does not suppress an approval in another thread of the same workspace", () => {
    expect(hrefMatchesLocation("/chat?workspace=a&thread=t9", "/chat", "?workspace=a")).toBe(false);
  });
  it("uses the active scope when the URL omits workspace", () => {
    expect(hrefMatchesLocation("/chat?workspace=team-a&thread=t1", "/chat", "?thread=t1", "team-a")).toBe(true);
    expect(hrefMatchesLocation("/chat?workspace=team-b&thread=t1", "/chat", "?thread=t1", "team-a")).toBe(false);
    expect(hrefMatchesLocation("/chat?workspace=team-a&thread=t1", "/chat", "?workspace=team-b&thread=t1", "team-a")).toBe(false);
  });

});

describe("shouldPing — workspace conversations share /chat", () => {
  const onA: PingContext = { pathname: "/chat", search: "?workspace=a", tabVisible: true };

  it("pings for a gate raised by an assistant you are NOT looking at", () => {
    expect(shouldPing(notif("approval", { href: "/chat?workspace=b" }), onA)).toBe(true);
  });

  it("stays quiet for the conversation already on screen", () => {
    expect(shouldPing(notif("approval", { href: "/chat?workspace=a" }), onA)).toBe(false);
  });
});

describe("titleWithCount", () => {
  it("prefixes a count when something waits", () => {
    expect(titleWithCount("Valet", 2)).toBe("(2) Valet");
  });

  it("restores the bare title at zero rather than showing (0)", () => {
    expect(titleWithCount("Valet", 0)).toBe("Valet");
  });
});
