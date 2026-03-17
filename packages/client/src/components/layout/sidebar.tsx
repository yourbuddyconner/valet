import { Link, useRouterState } from '@tanstack/react-router';
import { cn } from '@/lib/cn';
import { useUIStore } from '@/stores/ui';
import { useNotificationCount, useOrchestratorInfo } from '@/api/orchestrator';

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  showBadge?: boolean;
  indent?: boolean;
};

const staticNavItems: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: DashboardIcon },
  { href: '/orchestrator', label: 'Orchestrator', icon: OrchestratorIcon },
  // Orchestrator Chat is inserted dynamically after Orchestrator
  { href: '/inbox', label: 'Notifications', icon: InboxIcon, showBadge: true },
  { href: '/automation', label: 'Automation', icon: AutomationIcon },
  { href: '/sessions', label: 'Sessions', icon: SessionsIcon },
  { href: '/integrations', label: 'Integrations', icon: IntegrationsIcon },
  { href: '/settings/skills', label: 'Skills', icon: SkillsIcon },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUIStore();
  const router = useRouterState();
  const currentPath = router.location.pathname;
  const { data: inboxCount } = useNotificationCount();
  const { data: orchInfo } = useOrchestratorInfo();

  // Build nav items with dynamic orchestrator chat link
  const navItems: NavItem[] = staticNavItems.flatMap((item) => {
    if (item.href === '/orchestrator' && orchInfo?.sessionId) {
      return [
        item,
        { href: `/sessions/${orchInfo.sessionId}`, label: 'Chat', icon: ChatIcon, indent: true },
      ];
    }
    return [item];
  });

  return (
    <aside
      className={cn(
        'hidden h-dvh flex-col border-r border-neutral-200 bg-surface-1 transition-all duration-200 dark:border-neutral-800 dark:bg-surface-1 md:flex',
        sidebarCollapsed ? 'w-16' : 'w-60'
      )}
    >
      {/* Logo area */}
      <div className="flex h-14 items-center justify-between px-4">
        {!sidebarCollapsed && (
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent font-mono text-xs font-semibold text-white">
              V
            </div>
            <span className="font-mono text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
              valet
            </span>
          </div>
        )}
        {sidebarCollapsed && (
          <div className="mx-auto flex h-7 w-7 items-center justify-center rounded-md bg-accent font-mono text-xs font-semibold text-white">
            V
          </div>
        )}
      </div>

      <nav className="flex-1 px-2 py-1">
        <ul className="space-y-0.5">
          {navItems.map((item) => {
            const matchesThis =
              item.href === '/'
                ? currentPath === '/'
                : currentPath === item.href || currentPath.startsWith(item.href + '/');
            // If a more-specific nav item also matches, this one shouldn't be active
            const hasMoreSpecificMatch = matchesThis && navItems.some(
              (other) =>
                other.href !== item.href &&
                other.href.startsWith(item.href + '/') &&
                (currentPath === other.href || currentPath.startsWith(other.href + '/'))
            );
            const isActive = matchesThis && !hasMoreSpecificMatch;
            const badgeCount = item.showBadge ? inboxCount : undefined;

            return (
              <li key={item.href}>
                <Link
                  to={item.href}
                  className={cn(
                    'group flex items-center gap-3 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                    item.indent && !sidebarCollapsed && 'pl-7',
                    isActive
                      ? 'bg-accent/10 text-accent dark:bg-accent/10 dark:text-accent'
                      : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-500 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-200'
                  )}
                >
                  <span className="relative shrink-0">
                    <item.icon className={cn(
                      'h-[18px] w-[18px] transition-colors',
                      isActive ? 'text-accent' : 'text-neutral-400 group-hover:text-neutral-600 dark:text-neutral-600 dark:group-hover:text-neutral-400'
                    )} />
                    {sidebarCollapsed && badgeCount != null && badgeCount > 0 && (
                      <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-[8px] font-bold text-white">
                        {badgeCount > 9 ? '9+' : badgeCount}
                      </span>
                    )}
                  </span>
                  {!sidebarCollapsed && (
                    <>
                      <span className="flex-1">{item.label}</span>
                      {badgeCount != null && badgeCount > 0 && (
                        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">
                          {badgeCount > 99 ? '99+' : badgeCount}
                        </span>
                      )}
                    </>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Collapse toggle */}
      <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
        <button
          onClick={toggleSidebar}
          className="flex w-full items-center justify-center rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-600 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-400"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronIcon collapsed={sidebarCollapsed} />
        </button>
      </div>
    </aside>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('transition-transform duration-200', collapsed && 'rotate-180')}
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </svg>
  );
}

function SessionsIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 6.1H3" />
      <path d="M21 12.1H3" />
      <path d="M15.1 18H3" />
    </svg>
  );
}

function AutomationIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function IntegrationsIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

function OrchestratorIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 8V4H8" />
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M12 8a4 4 0 1 0 0 8" />
      <path d="M12 16a4 4 0 1 0 0-8" />
      <path d="M12 16v4h4" />
      <rect width="8" height="4" x="8" y="18" rx="1" ry="1" />
    </svg>
  );
}

function InboxIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function SkillsIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </svg>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
