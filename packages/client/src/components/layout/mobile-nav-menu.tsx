import { useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '@/lib/cn';

const navItems = [
  { href: '/', label: 'Dashboard', icon: DashboardIcon },
  { href: '/orchestrator', label: 'Orchestrator', icon: OrchestratorIcon },
  { href: '/inbox', label: 'Notifications', icon: InboxIcon },
  { href: '/automation', label: 'Automation', icon: AutomationIcon },
  { href: '/sessions', label: 'Sessions', icon: SessionsIcon },
  { href: '/integrations', label: 'Integrations', icon: IntegrationsIcon },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

interface MobileNavMenuProps {
  className?: string;
}

/**
 * Hamburger menu for mobile navigation.
 * Opens a slide-in drawer with app navigation links.
 * Touch-optimized with 44px minimum tap targets.
 */
export function MobileNavMenu({ className }: MobileNavMenuProps) {
  const [open, setOpen] = useState(false);
  const router = useRouterState();
  const currentPath = router.location.pathname;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          className={cn(
            // 44px touch target minimum for accessibility
            'flex h-11 w-11 -ml-1.5 items-center justify-center rounded-lg',
            'text-neutral-600 dark:text-neutral-400',
            'transition-all duration-150',
            'active:scale-95 active:bg-neutral-100 dark:active:bg-neutral-800',
            className
          )}
          aria-label="Open navigation menu"
        >
          <HamburgerIcon className="h-5 w-5" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[70]',
            'bg-black/60 backdrop-blur-[2px]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'duration-200'
          )}
        />
        <Dialog.Content
          className={cn(
            'fixed left-0 top-0 z-[70] h-full w-[280px]',
            'bg-surface-0 dark:bg-surface-1',
            'shadow-2xl shadow-black/20',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
            'duration-300 ease-out'
          )}
        >
          {/* Header with logo and close */}
          <div className="flex h-14 items-center justify-between border-b border-border/50 px-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent shadow-sm shadow-accent/20 font-mono text-sm font-bold text-white">
                V
              </div>
              <div className="flex flex-col">
                <span className="font-mono text-[13px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
                  valet
                </span>
                <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                  v1.0
                </span>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg',
                  'text-neutral-400 dark:text-neutral-500',
                  'transition-all duration-150',
                  'hover:bg-neutral-100 hover:text-neutral-600',
                  'dark:hover:bg-neutral-800 dark:hover:text-neutral-300',
                  'active:scale-95'
                )}
                aria-label="Close menu"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          {/* Navigation links with staggered animation */}
          <nav className="px-3 py-4">
            <ul className="space-y-1">
              {navItems.map((item, index) => {
                const isActive =
                  item.href === '/'
                    ? currentPath === '/'
                    : currentPath.startsWith(item.href);

                return (
                  <li
                    key={item.href}
                    className="animate-stagger-in"
                    style={{ animationDelay: `${50 + index * 40}ms` }}
                  >
                    <Link
                      to={item.href}
                      onClick={() => setOpen(false)}
                      className={cn(
                        // 44px minimum height for touch
                        'group flex items-center gap-3.5 rounded-lg px-3.5 py-3 min-h-[44px]',
                        'text-[14px] font-medium',
                        'transition-all duration-150',
                        'active:scale-[0.98]',
                        isActive
                          ? 'bg-accent/10 text-accent dark:bg-accent/15'
                          : 'text-neutral-600 dark:text-neutral-400 active:bg-neutral-100 dark:active:bg-neutral-800'
                      )}
                    >
                      <div className={cn(
                        'flex h-9 w-9 items-center justify-center rounded-md',
                        'transition-colors duration-150',
                        isActive
                          ? 'bg-accent/15 dark:bg-accent/20'
                          : 'bg-neutral-100 dark:bg-neutral-800 group-active:bg-neutral-200 dark:group-active:bg-neutral-700'
                      )}>
                        <item.icon
                          className={cn(
                            'h-[18px] w-[18px] shrink-0 transition-colors',
                            isActive
                              ? 'text-accent'
                              : 'text-neutral-500 dark:text-neutral-400'
                          )}
                        />
                      </div>
                      <span>{item.label}</span>
                      {isActive && (
                        <div className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Bottom section with subtle branding */}
          <div className="absolute bottom-0 left-0 right-0 border-t border-border/30 p-4">
            <div className="flex items-center gap-2 text-neutral-400 dark:text-neutral-500">
              <div className="h-px flex-1 bg-gradient-to-r from-border/50 to-transparent" />
              <span className="font-mono text-[9px] uppercase tracking-[0.15em]">
                Background Agents
              </span>
              <div className="h-px flex-1 bg-gradient-to-l from-border/50 to-transparent" />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HamburgerIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="4" x2="20" y1="12" y2="12" />
      <line x1="4" x2="20" y1="6" y2="6" />
      <line x1="4" x2="20" y1="18" y2="18" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
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

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
