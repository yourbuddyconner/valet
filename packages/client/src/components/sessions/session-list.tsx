import * as React from 'react';
import { useInfiniteSessions } from '@/api/sessions';
import { SessionCard } from './session-card';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchInput } from '@/components/ui/search-input';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import type { SessionStatus } from '@/api/types';

const STATUS_OPTIONS: { value: SessionStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'idle', label: 'Idle' },
  { value: 'terminated', label: 'Terminated' },
  { value: 'error', label: 'Error' },
];

export function SessionList() {
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<SessionStatus | 'all'>('all');
  const { data, isLoading, error, fetchNextPage, isFetchingNextPage } = useInfiniteSessions();

  const sessions = data?.sessions ?? [];
  const hasMore = data?.hasMore ?? false;

  const filteredSessions = React.useMemo(() => {
    return sessions.filter((session) => {
      // Filter by status
      if (statusFilter !== 'all' && session.status !== statusFilter) {
        return false;
      }

      // Filter by search
      if (search) {
        const searchLower = search.toLowerCase();
        const workspaceMatch = session.workspace?.toLowerCase().includes(searchLower);
        return workspaceMatch;
      }

      return true;
    });
  }, [sessions, search, statusFilter]);

  if (isLoading) {
    return <SessionListSkeleton />;
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
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredSessions.map((session) => (
              <SessionCard key={session.id} session={session} />
            ))}
          </div>
          <LoadMoreButton
            onClick={() => fetchNextPage()}
            isLoading={isFetchingNextPage}
            hasMore={hasMore}
          />
        </>
      )}
    </div>
  );
}

function SessionListSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-neutral-200 bg-white p-6"
        >
          <div className="flex items-start justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-16" />
          </div>
          <div className="mt-4 flex items-center justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
