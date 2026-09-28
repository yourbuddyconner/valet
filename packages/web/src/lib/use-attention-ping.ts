import { useRouterState } from "@tanstack/react-router";
import type { NotificationKind, NotificationSummary } from "@valet/api/wire";
import { useEffect, useRef } from "react";
import { useNotifications } from "~/api/queries";
import { playAttentionChime } from "./notification-sound";
import { useWorkspaceScope } from "./workspace-scope";

/**
 * Tells you when the assistant is waiting on you, out loud.
 *
 * A background agent that blocks on a person and cannot reach them is this
 * product's core failure mode — the work simply stops, and the only way to
 * find out is to go looking. The notifications bell already collects these,
 * but a badge you have to be looking at does not help someone who tabbed
 * away, which is the entire point of a background agent.
 *
 * What it deliberately does NOT do is ping for everything. Only the kinds
 * that block on a person get a sound; a general update does not earn one.
 * A sound that fires when nothing is needed is a sound people turn off, and
 * then the one that mattered is silent too.
 */

/** Kinds where the agent is stopped until a person acts. `notification` is
 * an update — it goes to the bell and the title, never to the speaker. */
const NEEDS_ACTION: readonly NotificationKind[] = ["question", "escalation", "approval"];

/** One ping per burst. Three gates resolving at once is one interruption,
 * not three. */
const PING_COOLDOWN_MS = 4_000;

const SOUND_PREF_KEY = "valet:attention-sound";

export function isAttentionSoundEnabled(): boolean {
  try {
    // Default ON. This product exists to work while you look away, so the
    // signal that it needs you should not be opt-in.
    return window.localStorage.getItem(SOUND_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAttentionSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SOUND_PREF_KEY, enabled ? "on" : "off");
  } catch {
    // Storage unavailable (private mode, blocked cookies): the preference
    // is in-session only rather than an error.
  }
}

export function isActionable(n: NotificationSummary): boolean {
  return n.readAt === undefined && NEEDS_ACTION.includes(n.kind);
}

/** Kinds that announce a decision gate. For a session with an open WS the
 * stream store holds the live gate set, so these kinds defer to it — the
 * store both lights and clears without waiting for the poll. `escalation`
 * (a stuck submission) has no gate behind it and only the poll carries it. */
const GATE_BACKED: readonly NotificationKind[] = ["question", "approval"];

/**
 * Sessions with something unanswered waiting on a person, keyed by session
 * id. The notifications query is already polling for the bell, so a caller
 * that wants to mark a row costs no extra request.
 *
 * `livePendingGates` (see `useLivePendingGates`) upgrades the poll to live
 * data where it exists: a key is a session with an open WS, its value
 * whether any gate is pending there. For those sessions the store decides
 * the gate-backed kinds — a poll row lags the truth by up to 30s on open
 * and until the user reads the notification after resolve (TKAI-257).
 */
export function attentionSessionIds(
  notifications: NotificationSummary[] | undefined,
  livePendingGates?: Readonly<Record<string, boolean>>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const n of notifications ?? []) {
    if (!isActionable(n) || n.sessionId === undefined) continue;
    if (GATE_BACKED.includes(n.kind) && livePendingGates?.[n.sessionId] !== undefined) continue;
    out.add(n.sessionId);
  }
  for (const [sessionId, hasGates] of Object.entries(livePendingGates ?? {})) {
    if (hasGates) out.add(sessionId);
  }
  return out;
}

export interface PingContext {
  /** Where the user is right now, e.g. `/chat` or `/sessions/abc`. */
  pathname: string;
  /** The current query string, with or without its leading `?`. Needed
   * because `/chat` alone does not say WHICH conversation is open. */
  search: string;
  /** `document.visibilityState === "visible"`. */
  tabVisible: boolean;
  workspace?: string;
}

/**
 * Pure: should THIS notification make a sound?
 *
 * The judgement call is the last clause. If you are looking at the very
 * conversation the notification points to, the decision card is already on
 * screen and a sound tells you nothing you cannot see — so we stay quiet.
 * Tab hidden, or anywhere else in the app, and it plays.
 */
export function shouldPing(n: NotificationSummary, ctx: PingContext): boolean {
  if (!isActionable(n)) return false;
  if (!ctx.tabVisible) return true;
  if (n.href === undefined) return true;
  return !hrefMatchesLocation(n.href, ctx.pathname, ctx.search, ctx.workspace);
}

/** Suppress a sound only when its workspace and target thread are on screen. */
export function hrefMatchesLocation(href: string, pathname: string, search: string, workspace?: string): boolean {
  const [path, query = ""] = href.split("?");
  if (path !== pathname) return false;
  const target = new URLSearchParams(query);
  const current = new URLSearchParams(search.replace(/^\?/, ""));
  const targetWorkspace = target.get("workspace");
  if (targetWorkspace !== null && targetWorkspace !== (current.get("workspace") ?? workspace)) return false;
  const thread = target.get("thread");
  return thread === null || thread === current.get("thread");
}

/** The document title, with the count of things waiting on you. Restores
 * the bare title at zero rather than leaving a stale `(0)`. */
export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

export function useAttentionPing(): void {
  const notificationsQ = useNotifications();
  const { key: workspace } = useWorkspaceScope();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.searchStr });

  // Ids we have already considered. Seeded from the FIRST response without
  // pinging: everything unread at load is backlog, and announcing it would
  // make every page refresh sound like a fresh emergency.
  //
  // REPLACED, not accumulated, on each poll. Only ids in the current
  // response can be compared against the next one, so keeping older ids
  // grows the set for the tab's whole life and buys nothing. An id that
  // ages out and then returns is a notification the user has not been told
  // about in the meantime, so treating it as fresh is right anyway.
  const seen = useRef<Set<string> | null>(null);
  const lastPingAt = useRef(0);

  const notifications = notificationsQ.data?.notifications;

  useEffect(() => {
    if (!notifications) return;

    if (seen.current === null) {
      seen.current = new Set(notifications.map((n) => n.id));
      return;
    }

    const previous = seen.current;
    const fresh = notifications.filter((n) => !previous.has(n.id));
    seen.current = new Set(notifications.map((n) => n.id));
    if (fresh.length === 0) return;

    const ctx: PingContext = {
      pathname,
      search,
      workspace,
      tabVisible: typeof document !== "undefined" && document.visibilityState === "visible",
    };
    if (!fresh.some((n) => shouldPing(n, ctx))) return;
    if (!isAttentionSoundEnabled()) return;

    const now = Date.now();
    if (now - lastPingAt.current < PING_COOLDOWN_MS) return;
    lastPingAt.current = now;
    playAttentionChime();
  }, [notifications, pathname, search, workspace]);

  // The title the page chose for itself, captured once before this hook
  // first writes to it. Prefixing THAT rather than a hardcoded product name
  // means a page that titles itself keeps its title — otherwise every poll
  // would overwrite it, and several open tabs would be indistinguishable.
  const baseTitle = useRef<string | null>(null);

  // The title is the fallback that always works: muted tab, blocked
  // autoplay, headphones out. It costs nothing and it is the only signal
  // visible from another application's window.
  useEffect(() => {
    if (typeof document === "undefined") return;
    baseTitle.current ??= document.title || "Valet";
    const base = baseTitle.current;
    const count = (notifications ?? []).filter(isActionable).length;
    document.title = titleWithCount(base, count);
    return () => {
      document.title = base;
    };
  }, [notifications]);
}
