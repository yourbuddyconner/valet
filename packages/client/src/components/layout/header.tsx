import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '@/stores/auth';
import { useTheme } from '@/hooks/use-theme';
import { getBuildChrome } from '@/lib/build-info';
import { cn } from '@/lib/cn';
import { BuildBadge } from './build-badge';
import {
  useMarkNonActionableNotificationsRead,
  useNotificationCount,
  useNotifications,
} from '@/api/orchestrator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatRelativeTime } from '@/lib/format';
import type { MailboxMessageType } from '@/api/types';
import { MobileNavMenu } from './mobile-nav-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function Header() {
  const navigate = useNavigate();
  const { user, clearAuth } = useAuthStore();
  const { theme, setTheme, isDark } = useTheme();
  const { data: unreadCount = 0 } = useNotificationCount();
  const { data: notificationsData, isLoading: notificationsLoading } = useNotifications({ limit: 12 });
  const markNonActionableRead = useMarkNonActionableNotificationsRead();
  const [notificationsOpen, setNotificationsOpen] = React.useState(false);
  const clearAttemptedRef = React.useRef(false);
  const buildChrome = getBuildChrome();

  React.useEffect(() => {
    if (!notificationsOpen) {
      clearAttemptedRef.current = false;
      return;
    }
    if (clearAttemptedRef.current) return;
    if (unreadCount <= 0) return;
    clearAttemptedRef.current = true;
    markNonActionableRead.mutate();
  }, [notificationsOpen, unreadCount, markNonActionableRead]);

  const handleSignOut = () => {
    clearAuth();
    navigate({ to: '/login' });
  };

  const notifications = notificationsData?.messages ?? [];

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : user?.email?.[0]?.toUpperCase() ?? '?';

  return (
    <header
      className={cn(
        'relative flex h-12 items-center justify-between border-b px-4',
        buildChrome.headerClassName
      )}
    >
      <span className={cn('absolute inset-x-0 top-0 h-0.5', buildChrome.topBarClassName)} />

      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center md:hidden">
          <MobileNavMenu />
        </div>
        <BuildBadge />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={() => {
            if (theme === 'system') {
              setTheme(isDark ? 'light' : 'dark');
            } else if (theme === 'dark') {
              setTheme('light');
            } else {
              setTheme('dark');
            }
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-surface-2 hover:text-neutral-600 dark:hover:text-neutral-300"
          title={`Theme: ${theme}`}
        >
          {isDark ? (
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7.5" cy="7.5" r="3" />
              <path d="M7.5 1.5v1M7.5 12.5v1M1.5 7.5h1M12.5 7.5h1M3.26 3.26l.7.7M11.04 11.04l.7.7M11.04 3.26l-.7.7M3.26 11.04l-.7.7" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13.5 8.5a6 6 0 1 1-7-7 4.5 4.5 0 0 0 7 7z" />
            </svg>
          )}
        </button>

        <DropdownMenu open={notificationsOpen} onOpenChange={setNotificationsOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className="relative flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-surface-2 hover:text-neutral-600 dark:hover:text-neutral-300"
              aria-label="Notifications"
            >
              <BellIcon />
              {unreadCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-white">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[360px] max-w-[90vw] p-0">
            <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-medium text-neutral-900 dark:text-neutral-100">Notifications</p>
                {unreadCount > 0 && (
                  <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {unreadCount} unread
                  </span>
                )}
              </div>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                Non-actionable items clear on open
              </p>
            </div>

            <div className="max-h-[360px] overflow-y-auto p-1">
              {notificationsLoading ? (
                <div className="px-2 py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
                  Loading notifications...
                </div>
              ) : notifications.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
                  No notifications yet
                </div>
              ) : (
                notifications.map((item) => {
                  const sender = item.fromSessionTitle || item.fromUserName || item.fromUserEmail || 'Unknown';
                  const actionRequired = isActionRequiredType(item.messageType);
                  return (
                    <DropdownMenuItem
                      key={item.id}
                      className="items-start gap-2 rounded-md px-2 py-2"
                      onSelect={() => navigate({ to: '/inbox' })}
                    >
                      <div className="mt-1 shrink-0">
                        <span
                          className={`block h-2 w-2 rounded-full ${
                            actionRequired
                              ? 'bg-amber-500'
                              : item.read
                                ? 'bg-neutral-300 dark:bg-neutral-600'
                                : 'bg-accent'
                          }`}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="mb-0.5 flex items-center justify-between gap-2">
                          <span className="truncate text-[12px] font-medium text-neutral-900 dark:text-neutral-100">
                            {sender}
                          </span>
                          <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
                            {formatRelativeTime(item.lastActivityAt || item.createdAt)}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-[11px] text-neutral-600 dark:text-neutral-400">
                          {item.content}
                        </p>
                        <div className="mt-1">
                          <span
                            className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              actionRequired
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'
                            }`}
                          >
                            {item.messageType}
                          </span>
                        </div>
                      </div>
                    </DropdownMenuItem>
                  );
                })
              )}
            </div>

            <div className="border-t border-neutral-200 p-1 dark:border-neutral-700">
              <DropdownMenuItem
                className="justify-center text-[12px] font-medium text-accent"
                onSelect={() => navigate({ to: '/inbox' })}
              >
                View all notifications
              </DropdownMenuItem>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded-full ring-offset-surface-0 focus:outline-none focus:ring-2 focus:ring-accent/40">
              <Avatar className="h-7 w-7">
                <AvatarImage src={user?.avatarUrl ?? undefined} alt={user?.name ?? 'User'} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <p className="text-[13px] font-medium text-neutral-900 text-pretty dark:text-neutral-100">
                {user?.name ?? 'User'}
              </p>
              <p className="font-mono text-[11px] text-neutral-500 truncate dark:text-neutral-400">{user?.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleSignOut} className="text-[13px]">
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function isActionRequiredType(type: MailboxMessageType): boolean {
  return type === 'question' || type === 'escalation' || type === 'approval';
}

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.27 21a2 2 0 0 0 3.46 0" />
      <path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.86 18 12.11 18 8a6 6 0 1 0-12 0c0 4.11-1.41 5.86-2.74 7.33" />
    </svg>
  );
}
