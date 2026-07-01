import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useInfiniteSessions } from '@/api/sessions';
import type { AgentSession, SessionStatus, SessionOwnershipFilter } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchInput } from '@/components/ui/search-input';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { Checkbox } from '@/components/ui/checkbox';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SessionActionsMenu } from './session-actions-menu';
import { BulkDeleteDialog } from './bulk-delete-dialog';
import { formatRelativeTime } from '@/lib/format';

const STATUS_OPTIONS: { value: SessionStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'idle', label: 'Idle' },
  { value: 'terminated', label: 'Terminated' },
  { value: 'archived', label: 'Archived' },
  { value: 'error', label: 'Error' },
];

const OWNERSHIP_OPTIONS: { value: SessionOwnershipFilter; label: string }[] = [
  { value: 'all', label: 'All Sessions' },
  { value: 'mine', label: 'My Sessions' },
  { value: 'shared', label: 'Shared with Me' },
];

const STATUS_VARIANTS: Record<
  SessionStatus,
  'default' | 'success' | 'warning' | 'error' | 'secondary'
> = {
  initializing: 'warning',
  running: 'success',
  idle: 'default',
  waiting_runner: 'warning',
  recovering: 'warning',
  backoff: 'error',
  hibernating: 'warning',
  hibernated: 'secondary',
  restoring: 'warning',
  terminated: 'secondary',
  archived: 'secondary',
  error: 'error',
};

export function SessionTable() {
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<SessionStatus | 'all'>('all');
  const [ownershipFilter, setOwnershipFilter] = React.useState<SessionOwnershipFilter>('all');
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error, fetchNextPage, isFetchingNextPage } = useInfiniteSessions(ownershipFilter);

  const sessions = data?.sessions ?? [];
  const hasMore = data?.hasMore ?? false;

  const filteredSessions = React.useMemo(() => {
    return sessions.filter((session) => {
      if (session.isOrchestrator) return false;
      if (statusFilter !== 'all' && session.status !== statusFilter) {
        return false;
      }
      if (search) {
        const searchLower = search.toLowerCase();
        return (
          session.workspace?.toLowerCase().includes(searchLower) ||
          session.title?.toLowerCase().includes(searchLower)
        );
      }
      return true;
    });
  }, [sessions, search, statusFilter]);

  // Build parent→children map and ordered render list
  const orderedSessions = React.useMemo(() => {
    const childrenByParent = new Map<string, AgentSession[]>();
    const parentIds = new Set(filteredSessions.map((s) => s.id));

    for (const session of filteredSessions) {
      if (session.parentSessionId && parentIds.has(session.parentSessionId)) {
        const children = childrenByParent.get(session.parentSessionId) ?? [];
        children.push(session);
        childrenByParent.set(session.parentSessionId, children);
      }
    }

    const result: { session: AgentSession; isChild: boolean }[] = [];
    for (const session of filteredSessions) {
      // Skip children that will be rendered under their parent
      if (session.parentSessionId && parentIds.has(session.parentSessionId)) {
        continue;
      }
      result.push({ session, isChild: false });
      const children = childrenByParent.get(session.id);
      if (children) {
        for (const child of children) {
          result.push({ session: child, isChild: true });
        }
      }
    }
    return result;
  }, [filteredSessions]);

  // Reset selection when filters change
  React.useEffect(() => {
    setSelectedIds(new Set());
  }, [search, statusFilter, ownershipFilter]);

  const allVisibleSelected =
    filteredSessions.length > 0 &&
    filteredSessions.every((s) => selectedIds.has(s.id));
  const someSelected = selectedIds.size > 0;
  const indeterminate = someSelected && !allVisibleSelected;

  const toggleAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredSessions.map((s) => s.id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (isLoading) {
    return <SessionTableSkeleton />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
        <p className="text-sm text-red-600 text-pretty dark:text-red-400">
          Failed to load sessions. Please try again.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:max-w-xs">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search sessions..."
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setStatusFilter(option.value)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  statusFilter === option.value
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {OWNERSHIP_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setOwnershipFilter(option.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                ownershipFilter === option.value
                  ? 'bg-violet-600 text-white dark:bg-violet-500'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk action bar */}
      {someSelected && (
        <div className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2 dark:border-neutral-700 dark:bg-neutral-800/50">
          <span className="text-sm text-neutral-600 dark:text-neutral-400">
            {selectedIds.size} session{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <button
            onClick={() => setBulkDeleteOpen(true)}
            className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 transition-colors"
          >
            Delete selected
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            Clear selection
          </button>
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
          <p className="text-sm text-neutral-500 text-pretty dark:text-neutral-400">
            No sessions yet. Create your first session to get started.
          </p>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
          <p className="text-sm text-neutral-500 text-pretty dark:text-neutral-400">
            No sessions match your filters.
          </p>
        </div>
      ) : (
        <>
          <div className="relative overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/50">
                  <th className="w-10 px-3 py-3">
                    <Checkbox
                      checked={allVisibleSelected}
                      indeterminate={indeterminate}
                      onChange={toggleAll}
                      aria-label="Select all sessions"
                    />
                  </th>
                  <th className="px-3 py-3 text-left font-medium text-neutral-500 dark:text-neutral-400">
                    Workspace
                  </th>
                  <th className="hidden px-3 py-3 text-left font-medium text-neutral-500 dark:text-neutral-400 lg:table-cell">
                    Creator
                  </th>
                  <th className="hidden px-3 py-3 text-left font-medium text-neutral-500 dark:text-neutral-400 sm:table-cell">
                    Participants
                  </th>
                  <th className="px-3 py-3 text-left font-medium text-neutral-500 dark:text-neutral-400">
                    Status
                  </th>
                  <th className="hidden px-3 py-3 text-left font-medium text-neutral-500 dark:text-neutral-400 md:table-cell">
                    Last Active
                  </th>
                  <th className="w-12 px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-700">
                {orderedSessions.map(({ session, isChild }) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    isChild={isChild}
                    selected={selectedIds.has(session.id)}
                    onToggle={() => toggleOne(session.id)}
                    onNavigate={() =>
                      navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId: session.id },
                      })
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
          <LoadMoreButton
            onClick={() => fetchNextPage()}
            isLoading={isFetchingNextPage}
            hasMore={hasMore}
          />
        </>
      )}

      <BulkDeleteDialog
        sessionIds={Array.from(selectedIds)}
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        onDeleted={() => setSelectedIds(new Set())}
      />
    </div>
  );
}

function getInitials(name?: string, email?: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  if (email) {
    return email.slice(0, 2).toUpperCase();
  }
  return '??';
}

function SessionRow({
  session,
  isChild,
  selected,
  onToggle,
  onNavigate,
}: {
  session: AgentSession;
  isChild: boolean;
  selected: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const displayName = session.title || session.workspace;
  const ownerInitials = getInitials(session.ownerName, session.ownerEmail);
  const ownerDisplayName = session.ownerName || session.ownerEmail || 'Unknown';
  const participantCount = session.participantCount ?? 0;
  const participants = session.participants ?? [];

  return (
    <tr
      className="cursor-pointer bg-white transition-colors hover:bg-neutral-50 dark:bg-neutral-900 dark:hover:bg-neutral-800/50"
      onClick={onNavigate}
    >
      <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${displayName}`}
        />
      </td>
      <td className="px-3 py-3 font-medium text-neutral-900 dark:text-neutral-100">
        <div className="flex items-center gap-2">
          {isChild && (
            <span className="text-neutral-400 dark:text-neutral-500 pl-4">
              ↳
            </span>
          )}
          <span>{displayName}</span>
          {isChild && (
            <span className="text-[11px] font-normal text-neutral-400 dark:text-neutral-500">
              sub-session
            </span>
          )}
        </div>
      </td>
      <td className="hidden px-3 py-3 lg:table-cell">
        <div className="flex items-center gap-2">
          <Avatar className="h-6 w-6">
            {session.ownerAvatarUrl && (
              <AvatarImage src={session.ownerAvatarUrl} alt={ownerDisplayName} />
            )}
            <AvatarFallback className="text-[10px]">{ownerInitials}</AvatarFallback>
          </Avatar>
          <span className="text-sm text-neutral-600 dark:text-neutral-400 truncate max-w-[120px]">
            {session.isOwner ? 'You' : ownerDisplayName}
          </span>
        </div>
      </td>
      <td className="hidden px-3 py-3 sm:table-cell">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default">
                {participantCount > 0 ? (
                  <>
                    <div className="flex -space-x-1.5">
                      {participants.slice(0, 3).map((p) => (
                        <Avatar key={p.userId} className="h-5 w-5 ring-2 ring-white dark:ring-neutral-900">
                          {p.avatarUrl && <AvatarImage src={p.avatarUrl} alt={p.name || p.email} />}
                          <AvatarFallback className="text-[8px]">
                            {getInitials(p.name, p.email)}
                          </AvatarFallback>
                        </Avatar>
                      ))}
                      {participantCount > 3 && (
                        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-200 text-[9px] font-medium text-neutral-600 ring-2 ring-white dark:bg-neutral-700 dark:text-neutral-300 dark:ring-neutral-900">
                          +{participantCount - 3}
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {participantCount}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-neutral-400 dark:text-neutral-500">—</span>
                )}
              </div>
            </TooltipTrigger>
            {participantCount > 0 && (
              <TooltipContent side="bottom" className="max-w-xs">
                <div className="space-y-1.5 py-1">
                  <div className="text-[11px] font-medium text-neutral-400 uppercase tracking-wide">
                    Participants ({participantCount})
                  </div>
                  {participants.map((p) => (
                    <div key={p.userId} className="flex items-center gap-2">
                      <Avatar className="h-5 w-5">
                        {p.avatarUrl && <AvatarImage src={p.avatarUrl} alt={p.name || p.email} />}
                        <AvatarFallback className="text-[8px]">
                          {getInitials(p.name, p.email)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col">
                        <span className="text-xs font-medium">{p.name || p.email}</span>
                        <span className="text-[10px] text-neutral-400">{p.role}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      </td>
      <td className="px-3 py-3">
        <Badge variant={STATUS_VARIANTS[session.status]}>{session.status}</Badge>
      </td>
      <td className="hidden px-3 py-3 text-neutral-500 tabular-nums dark:text-neutral-400 md:table-cell">
        {formatRelativeTime(session.lastActiveAt)}
      </td>
      <td className="w-12 px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <SessionActionsMenu
          session={session}
          showOpen={false}
          showEditorLink={true}
        />
      </td>
    </tr>
  );
}

function SessionTableSkeleton() {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/50">
            <th className="w-10 px-3 py-3">
              <Skeleton className="h-4 w-4" />
            </th>
            <th className="px-3 py-3 text-left">
              <Skeleton className="h-4 w-20" />
            </th>
            <th className="hidden px-3 py-3 text-left lg:table-cell">
              <Skeleton className="h-4 w-16" />
            </th>
            <th className="hidden px-3 py-3 text-left sm:table-cell">
              <Skeleton className="h-4 w-20" />
            </th>
            <th className="px-3 py-3 text-left">
              <Skeleton className="h-4 w-14" />
            </th>
            <th className="hidden px-3 py-3 text-left md:table-cell">
              <Skeleton className="h-4 w-24" />
            </th>
            <th className="w-12 px-3 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {Array.from({ length: 8 }).map((_, i) => (
            <tr key={i} className="bg-white dark:bg-neutral-900">
              <td className="w-10 px-3 py-3">
                <Skeleton className="h-4 w-4" />
              </td>
              <td className="px-3 py-3">
                <Skeleton className="h-4 w-32" />
              </td>
              <td className="hidden px-3 py-3 lg:table-cell">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-6 w-6 rounded-full" />
                  <Skeleton className="h-4 w-20" />
                </div>
              </td>
              <td className="hidden px-3 py-3 sm:table-cell">
                <div className="flex items-center gap-1">
                  <Skeleton className="h-5 w-5 rounded-full" />
                  <Skeleton className="h-4 w-4" />
                </div>
              </td>
              <td className="px-3 py-3">
                <Skeleton className="h-5 w-16 rounded-full" />
              </td>
              <td className="hidden px-3 py-3 md:table-cell">
                <Skeleton className="h-4 w-24" />
              </td>
              <td className="w-12 px-3 py-3">
                <Skeleton className="h-4 w-4" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
