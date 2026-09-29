import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef } from "react";
import { useOrg } from "~/api/settings";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "~/components/primitives";
import { useResponsiveOverlay } from "~/hooks/use-responsive-overlay";
import { cn } from "~/lib/cn";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * The settings shell's left rail (split-settings design, "Visual direction"
 * + "Routes & navigation"; amended 2026-08-28). The **You** group stays visible.
 * A selected team adds **Team**, alongside
 * **Organization** (shown once the `useOrg()` query resolves to gate-on — hidden otherwise, never disabled, and
 * rendered with no flash since it appears only once cached data arrives
 * rather than defaulting open then collapsing). An org admin sees every
 * Organization item; a plain member sees only Teams, because any member
 * can create a team and administer the teams they created.
 *
 * Active-state styling is computed from the current pathname (via `cn`'s
 * `twMerge`) rather than TanStack's `activeProps`, which only concatenates
 * class strings — for two same-specificity utilities like `text-muted` and
 * `text-moss`, whichever comes later in the generated stylesheet wins
 * regardless of prop order, which silently dropped the moss active state.
 */

export const TEAM_SETTINGS_PATH = "/settings/team";
const TEAM_ITEMS = [
  { to: TEAM_SETTINGS_PATH, label: "General" },
  { to: "/settings/api-keys", label: "API keys" },
  { to: "/settings/proxy", label: "Proxy" },
  { to: "/settings/policies", label: "Policies" },
];

/** Routes whose settings follow the selected team. */
export function isTeamSettingsPath(pathname: string): boolean {
  return TEAM_ITEMS.some((item) => item.to === pathname);
}

const YOU_ITEMS = [
  { to: "/settings/profile", label: "Profile" },
  { to: "/settings/threads", label: "Thread defaults" },
  { to: "/settings/appearance", label: "Appearance" },
  { to: "/settings/notifications", label: "Notifications" },
  { to: "/settings/connected-accounts", label: "Connected accounts" },
  { to: "/settings/api-keys", label: "API keys" },
  { to: "/settings/proxy", label: "Proxy" },
  // No "Library sources" item: personal and team repositories are tracked on
  // /skills, beside the skills they produce. Organization · Library keeps the
  // org ones, which only an admin changes.
  { to: "/settings/policies", label: "Policies" },
] as const;

/** Single-user-mode stand-in for Organization · Models — shown under "You"
 * only while the org gate is OFF (`/settings/models` renders the same
 * sections; the org-admin API authorizes the seeded local user). A gate-on
 * plain member gets no Models item at all: every section on that page reads
 * org-admin-only APIs, so the link would lead to a page of error banners. */
const MODELS_ITEM = { to: "/settings/models", label: "Models" } as const;

/** One source of truth for the Teams path — the rail's two item lists and
 * the `/settings/organization` route guard must never disagree on it. */
export const ORG_TEAMS_PATH = "/settings/organization/teams";

/** Same rule for 1Password: the page carries the member's OWN service-account
 * token beside the admin-only org token, and `GET /api/onepassword/settings`
 * answers any member, so a member who may connect one needs the link. The
 * panel hides the org token row and the toggle from a non-admin. */
export const ORG_ONEPASSWORD_PATH = "/settings/organization/onepassword";

const ORGANIZATION_ITEMS = [
  { to: "/settings/organization", label: "General" },
  { to: "/settings/organization/members", label: "Members" },
  { to: ORG_TEAMS_PATH, label: "Teams" },
  { to: "/settings/organization/models", label: "Models" },
  { to: "/settings/organization/plugins", label: "Plugins" },
  { to: "/settings/organization/proxy", label: "Proxy" },
  { to: "/settings/organization/library", label: "Library" },
  { to: "/settings/organization/github", label: "GitHub" },
  { to: "/settings/organization/slack", label: "Slack" },
  { to: "/settings/organization/linear", label: "Linear app" },
  { to: ORG_ONEPASSWORD_PATH, label: "1Password" },
  { to: "/settings/organization/sandbox-images", label: "Sandbox settings" },
  { to: "/settings/organization/policies", label: "Policies" },
  { to: "/settings/organization/action-log", label: "Action log" },
] as const;

/** The Organization items a plain member can use: any member can create a
 * team, and the creator administers it as its team admin; 1Password holds
 * the member's own personal token. */
const MEMBER_ORGANIZATION_ITEMS = [
  { to: ORG_TEAMS_PATH, label: "Teams" },
  { to: ORG_ONEPASSWORD_PATH, label: "1Password" },
] as const;

export function SettingsRail() {
  const sectionMenu = useResponsiveOverlay("sm");
  const { teamId } = useWorkspaceScope();
  const orgQ = useOrg();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const orgAdmin = orgQ.data?.callerRole === "admin";
  const showOrganizationGroup = orgQ.data?.features.organizations === true;
  const organizationItems = orgAdmin ? ORGANIZATION_ITEMS : MEMBER_ORGANIZATION_ITEMS;

  // Wait for `useOrg()` to resolve before appending — same no-flash rule as
  // the Organization group (an org-mode admin must never see the item
  // appear and then vanish). Keyed to the gate, not the caller's role: with
  // the gate on, an admin finds Models in the Organization group, and a
  // plain member gets no Models link at all (see MODELS_ITEM's comment).
  const youItems = orgQ.data && !showOrganizationGroup ? [...YOU_ITEMS, MODELS_ITEM] : YOU_ITEMS;

  // Workspace-aware settings belong only in Team when a team is selected.
  const personalItems = teamId === undefined
    ? youItems
    : youItems.filter((item) => !isTeamSettingsPath(item.to));
  const groups = [
    { label: "You", items: personalItems },
    ...(teamId === undefined ? [] : [{ label: "Team", items: TEAM_ITEMS }]),
    ...(showOrganizationGroup ? [{ label: "Organization", items: organizationItems }] : []),
  ];
  const currentGroup = groups.find((group) => group.items.some((item) => item.to === pathname));
  const current = currentGroup?.items.find((item) => item.to === pathname);
  const currentLabel = current ? `${currentGroup?.label} / ${current.label}` : "Choose section";

  return (
    <nav aria-label="Settings" className="w-full shrink-0 text-sm sm:w-[200px]">
      <div className="sm:hidden">
        <DropdownMenu open={sectionMenu.open} onOpenChange={sectionMenu.setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" className="w-full justify-between" aria-label={`Settings section: ${currentLabel}`}>
              <span className="truncate">{currentLabel}</span>
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
            {groups.map((group) => (
              <DropdownMenuGroup key={group.label} aria-label={group.label}>
                <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                {group.items.map((item) => (
                  <DropdownMenuItem key={item.to} asChild>
                    <Link to={item.to} aria-current={pathname === item.to ? "page" : undefined} className={pathname === item.to ? "bg-moss-wash text-moss" : undefined}>
                      {item.label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="hidden space-y-6 sm:block">
        {groups.map((group) => <RailGroup key={group.label} {...group} pathname={pathname} />)}
      </div>
    </nav>
  );
}

function RailGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: ReadonlyArray<{ to: string; label: string }>;
  pathname: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const rail = list.current;
    const active = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (rail && active && rail.scrollWidth > rail.clientWidth) {
      rail.scrollLeft += active.getBoundingClientRect().left - rail.getBoundingClientRect().left;
    }
  }, [pathname, items]);
  return (
    <div>
      <div className="mb-1.5 px-2 text-xs font-medium uppercase tracking-wider text-muted">
        {label}
      </div>
      <ul ref={list} className="flex gap-1 overflow-x-auto pb-1 sm:block sm:space-y-0.5 sm:pb-0">
        {items.map((item) => {
          const active = pathname === item.to;
          return (
            <li key={item.to} className="shrink-0">
              <Link
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block whitespace-nowrap rounded px-2 py-1.5 transition-colors",
                  active
                    ? "bg-moss-wash text-moss"
                    : "text-muted hover:bg-ink-wash hover:text-ink",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
