import { WorkspaceAssistantButton } from "./workspace-assistant";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, Menu, PanelLeftClose, PanelLeftOpen, Settings, ShieldCheck } from "lucide-react";
import { useChangelog } from "~/api/changelog";
import { useWorkspaceRuntimeInfo } from "~/api/workspace-runtime";
import { useSession } from "~/api/queries";
import { pluginEnabledForCaller, useMe, useOrg, useTeams } from "~/api/settings";
import { PresenceMark } from "~/components/assistant/presence-mark";
import {
  WorkspaceSwitcher,
  workspaceOptions,
} from "~/components/layout/workspace-switcher";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/primitives";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { useResponsiveOverlay } from "~/hooks/use-responsive-overlay";
import { useLastSeenCheckpoint } from "~/lib/changelog-read-state";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { useSidebarControls } from "./app-shell";
import { NotificationsBell } from "./notifications-bell";

/**
 * Top-nav link with a working active state. Text color lives in
 * `activeProps`/`inactiveProps` — NOT the base className — because TanStack
 * Router concatenates `activeProps.className` onto the base, and two
 * conflicting Tailwind text colors resolve by stylesheet order, not by
 * which was added last (the old `text-muted` base + `text-ink` active pair
 * rendered no visible active state at all).
 */
const NAV_ACTIVE = "text-ink font-medium bg-ink-wash";
const NAV_INACTIVE = "text-muted hover:text-ink";

function NavLink({
  to,
  children,
  active,
}: {
  to: string;
  children: React.ReactNode;
  /** Force the active state instead of the URL-match default. Used so a
   * `/sessions/:id` security session lights "Security" —
   * the URL alone cannot tell the two apart (both live under /sessions). */
  active?: boolean;
}) {
  // `shrink-0` + `whitespace-nowrap`: the row scrolls when it does not fit,
  // so a link must keep its own width instead of being squeezed into a
  // wrapped two-line label.
  const base = "shrink-0 whitespace-nowrap rounded px-2 py-1 text-sm hover:bg-ink-wash";
  if (active !== undefined) {
    return (
      <Link to={to} className={`${base} ${active ? NAV_ACTIVE : NAV_INACTIVE}`}>
        {children}
      </Link>
    );
  }
  return (
    <Link
      to={to}
      className={base}
      activeProps={{ className: NAV_ACTIVE }}
      inactiveProps={{ className: NAV_INACTIVE }}
    >
      {children}
    </Link>
  );
}

/**
 * The sidebar toggle, at the nav's left edge — the first thing in the row,
 * ahead of the logo, which is where Linear, Notion and VS Code put it.
 *
 * It lives here rather than floating over the sidebar so that it occupies
 * layout instead of overlapping it; the old floated version covered the
 * assistants rail's "New assistant" button. See `SidebarControls`.
 *
 * Two buttons, not one, because they do different things and must say so:
 * on mobile the sidebar is out of the flow and opens as a drawer, while on
 * desktop it collapses in place. One button with a width-dependent label
 * would announce the wrong action to a screen reader at one of the two
 * widths.
 *
 * Renders nothing when there is no sidebar to control, including outside an
 * `AppShell` entirely.
 */
function SidebarToggle() {
  const controls = useSidebarControls();
  if (controls === null || !controls.present) return null;

  const buttonClass =
    "shrink-0 min-h-11 min-w-11 md:min-h-0 md:min-w-0 items-center justify-center rounded p-1.5 text-muted hover:bg-ink-wash hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none";

  return (
    <>
      <button
        type="button"
        aria-label="Open threads"
        onClick={controls.openDrawer}
        className={`md:hidden inline-flex ${buttonClass}`}
      >
        <PanelLeftOpen className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={controls.collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!controls.collapsed}
        onClick={controls.toggleCollapsed}
        className={`hidden md:inline-flex ${buttonClass}`}
      >
        {controls.collapsed ? (
          <PanelLeftOpen className="h-4 w-4" aria-hidden />
        ) : (
          <PanelLeftClose className="h-4 w-4" aria-hidden />
        )}
      </button>
    </>
  );
}

export function TopNav() {
  const mobileNav = useResponsiveOverlay("md");
  const scope = useWorkspaceScope();
  const info = useWorkspaceRuntimeInfo(scope.key);
  const presence = info.data?.presence ?? "idle";

  // The switcher reads the same three queries the rail does, so switching
  // costs no extra request — react-query serves all three from cache.
  const teamsQ = useTeams();
  const orgQ = useOrg();
  const meQ = useMe();
  const changelogQ = useChangelog();
  const newestCheckpoint = changelogQ.data?.manifest.checkpoints[0];
  const seenCheckpoint = useLastSeenCheckpoint(meQ.data?.id);
  const changelogUnread = !!meQ.data && !!newestCheckpoint && seenCheckpoint !== newestCheckpoint.id;
  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const options = workspaceOptions(teams);
  // The active workspace is no longer derived here from `?assistant=`. That
  // only ever resolved on `/chat`, so every other page read "Personal"
  // regardless of the workspace the reader was in. The scope owns it now and
  // still lets the open assistant win — see `workspace-scope.tsx`.
  const onChat = useRouterState({ select: (st) => st.location.pathname === "/chat" });
  // A security session lives at /sessions/:id like any other, so the URL
  // cannot distinguish it — read the id off the path and check its kind so
  // the nav lights "Security". The query is shared
  // with the session page's own read, so it costs no extra request.
  const sessionRouteId = useRouterState({
    select: (st) => {
      const m = /^\/sessions\/([^/]+)$/.exec(st.location.pathname);
      return m ? m[1] : undefined;
    },
  });
  const routeSession = useSession(sessionRouteId ?? "");
  const onSecuritySession = routeSession.data?.kind === "security";
  const onSecurityPage = useRouterState({ select: (st) => st.location.pathname.startsWith("/security") });
  // Gate the Security link on the `security` plugin's entitlement for this
  // caller. `undefined` (org not yet loaded) hides the link — no flash of a
  // link the caller may not have, matching the settings rail's no-flash rule.
  const securityEnabled = pluginEnabledForCaller(orgQ.data, "security") === true;
  const destinations: Array<{ to: string; label: string; active?: boolean }> = [
    { to: "/chat", label: "Threads" },
    { to: "/memory", label: "Memory" },
    { to: "/workflows", label: "Workflows" },
    { to: "/events", label: "Events" },
    { to: "/usage", label: "Usage" },
    { to: "/skills", label: "Skills" },
    { to: "/integrations", label: "Integrations" },
    { to: "/changelog", label: "Changelog" },
  ];
  const destinationLabel = (label: string) => (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {label === "Changelog" && changelogUnread && (
        <span className="h-1.5 w-1.5 rounded-full bg-accent-500" aria-label="New releases" />
      )}
    </span>
  );

  // The logo is the PRODUCT (Valet), not the orchestrator — the
  // orchestrator's chosen name shows up in its own title card (session
  // header) instead. The presence dot stays: it still reflects the
  // orchestrator's live state at a glance from anywhere in the app.
  return (
    <header className="max-sm:[--nav-height:3rem] h-[--nav-height] shrink-0 border-b border-line bg-paper flex items-center gap-1 px-2 md:gap-4 md:px-3">
      <SidebarToggle />

      <Link
        to="/"
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded px-1.5 py-1 hover:bg-ink-wash md:min-h-0 md:min-w-0"
        aria-label="Valet — dashboard"
      >
        <span className="text-moss text-base leading-none" aria-hidden>
          ◈
        </span>
        <span className="hidden md:inline-flex"><PresenceMark name="Valet" state={presence} size="nav" /></span>
      </Link>

      {/* Beside the logo, not in the sidebar: it scopes the surfaces below
          rather than filtering one list. */}
      <WorkspaceSwitcher
        options={options}
        activeKey={scope.key}
        onSelect={scope.setKey}
        navigateOnSelect={onChat}
      />

      <nav
        aria-label="Primary"
        className="hidden min-w-0 flex-1 items-center gap-2 overflow-x-auto md:flex xl:justify-end [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {destinations.map(({ to, label, active }) => (
          <NavLink key={to} to={to} active={active}>{destinationLabel(label)}</NavLink>
        ))}
      </nav>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={`shrink-0 gap-1 ${onSecurityPage || onSecuritySession ? NAV_ACTIVE : NAV_INACTIVE}`}>
            Plugins <ChevronDown className="h-3 w-3" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="Plugins" className="w-56">
          {securityEnabled ? <DropdownMenuItem asChild>
            <Link to="/security"><ShieldCheck className="h-4 w-4" aria-hidden />Valet Security</Link>
          </DropdownMenuItem> : <div className="px-2 py-3 text-xs text-muted">No plugins available.</div>}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ml-auto shrink-0 md:hidden">
        <DropdownMenu open={mobileNav.open} onOpenChange={mobileNav.setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" aria-label="Open navigation" className="h-11 w-11 p-0">
              <Menu className="h-5 w-5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label="Navigation" className="w-64">
            {destinations.map(({ to, label, active }) => (
              <DropdownMenuItem key={to} asChild>
                <Link
                  to={to}
                  className={active === undefined ? undefined : active ? NAV_ACTIVE : NAV_INACTIVE}
                  activeProps={active === undefined ? { className: NAV_ACTIVE } : {}}
                  inactiveProps={active === undefined ? { className: NAV_INACTIVE } : {}}
                >
                  {destinationLabel(label)}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="shrink-0">
        <WorkspaceAssistantButton />
        <NotificationsBell />
      </div>

      <Link
        to="/settings"
        className="inline-flex shrink-0 min-h-11 min-w-11 md:min-h-0 md:min-w-0 items-center justify-center rounded p-1.5 text-muted hover:bg-ink-wash hover:text-ink"
        activeProps={{ className: "text-ink" }}
        aria-label="Settings"
      >
        <Settings className="h-4 w-4" />
      </Link>
    </header>
  );
}
