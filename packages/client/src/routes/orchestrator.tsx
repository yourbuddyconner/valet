import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusDot } from '@/components/session/session-metadata-sidebar';
import {
  useOrchestratorInfo,
  useCreateOrchestrator,
  useCheckHandle,
  useMemoryFiles,
} from '@/api/orchestrator';
import { MemoryExplorer } from '@/components/orchestrator/memory-explorer';
import { useAutoRestartOrchestrator } from '@/hooks/use-auto-restart-orchestrator';
import { useDebounced } from '@/hooks/use-debounced';
import { useInfiniteSessionChildren, useSessionDoStatus } from '@/api/sessions';
import { formatRelativeTime } from '@/lib/format';
import type { ChildSessionSummaryWithRuntime } from '@/api/sessions';
import { Checkbox } from '@/components/ui/checkbox';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { BulkDeleteDialog } from '@/components/sessions/bulk-delete-dialog';

export const Route = createFileRoute('/orchestrator')({
  component: OrchestratorPage,
});

function OrchestratorPage() {
  const { data: orchInfo, isLoading } = useOrchestratorInfo();

  if (isLoading) {
    return (
      <PageContainer>
        <PageHeader title="Orchestrator" description="Loading..." />
        <OrchestratorSkeleton />
      </PageContainer>
    );
  }

  if (!orchInfo?.identity) {
    return <SetupForm />;
  }

  return <OrchestratorDashboard />;
}

// ---------------------------------------------------------------------------
// Setup Form (migrated from orchestrator-setup.tsx)
// ---------------------------------------------------------------------------

function SetupForm() {
  const navigate = useNavigate();
  const createOrchestrator = useCreateOrchestrator();

  const [name, setName] = React.useState('');
  const [handle, setHandle] = React.useState('');
  const [customInstructions, setCustomInstructions] = React.useState('');

  const debouncedHandle = useDebounced(handle, 400);
  const handleCheck = useCheckHandle(debouncedHandle);
  const handleTaken = debouncedHandle.length >= 2 && handleCheck.data?.available === false;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (handleTaken) return;

    createOrchestrator.mutate(
      {
        name,
        handle: handle.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
        customInstructions: customInstructions || undefined,
      },
      {
        onSuccess: (data) => {
          navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: data.sessionId },
          });
        },
      }
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Set Up Your Orchestrator"
        description="Create your personal AI assistant that manages tasks and coordinates agent sessions"
      />

      <div className="mx-auto max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="orch-name"
                  className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
                >
                  Name
                </label>
                <input
                  id="orch-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jarvis"
                  className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
                />
                <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
                  Your orchestrator's display name
                </p>
              </div>

              <div>
                <label
                  htmlFor="orch-handle"
                  className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
                >
                  Handle
                </label>
                <div className="mt-1 flex items-center">
                  <span className="mr-1 text-sm text-neutral-400">@</span>
                  <input
                    id="orch-handle"
                    type="text"
                    required
                    value={handle}
                    onChange={(e) =>
                      setHandle(
                        e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '')
                      )
                    }
                    placeholder="jarvis"
                    className={`block w-full rounded-md border bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-1 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 ${
                      handleTaken
                        ? 'border-red-400 focus:border-red-500 focus:ring-red-500 dark:border-red-500 dark:focus:border-red-400 dark:focus:ring-red-400'
                        : 'border-neutral-300 focus:border-neutral-500 focus:ring-neutral-500 dark:border-neutral-600 dark:focus:border-neutral-400 dark:focus:ring-neutral-400'
                    }`}
                  />
                </div>
                {handleTaken ? (
                  <p className="mt-1 text-xs text-red-500 dark:text-red-400">
                    Handle @{debouncedHandle} is already taken
                  </p>
                ) : debouncedHandle.length >= 2 && handleCheck.data?.available ? (
                  <p className="mt-1 text-xs text-green-600 dark:text-green-400">
                    @{debouncedHandle} is available
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
                    Lowercase letters, numbers, dashes, and underscores only
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="orch-instructions"
                  className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
                >
                  Custom Instructions (optional)
                </label>
                <textarea
                  id="orch-instructions"
                  rows={4}
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  placeholder="Any special instructions for your orchestrator..."
                  className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
                />
              </div>
            </div>
          </div>

          {createOrchestrator.isError && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-400">
              {(createOrchestrator.error as any)?.message || 'Failed to create orchestrator'}
            </div>
          )}

          <Button
            type="submit"
            disabled={!name || !handle || handleTaken || createOrchestrator.isPending}
            className="w-full"
          >
            {createOrchestrator.isPending ? 'Creating...' : 'Create Orchestrator'}
          </Button>
        </form>
      </div>
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const STATUS_VARIANTS: Record<string, 'default' | 'success' | 'warning' | 'error' | 'secondary'> = {
  initializing: 'warning',
  running: 'success',
  idle: 'default',
  hibernating: 'warning',
  hibernated: 'secondary',
  restoring: 'warning',
  terminated: 'secondary',
  archived: 'secondary',
  error: 'error',
};

function OrchestratorDashboard() {
  const { data: orchInfo } = useOrchestratorInfo();
  const { data: doStatus } = useSessionDoStatus(orchInfo?.sessionId ?? '');
  const [hideTerminated, setHideTerminated] = React.useState(true);
  const childrenQuery = useInfiniteSessionChildren(orchInfo?.sessionId ?? '', { hideTerminated });
  const { data: memoryFiles } = useMemoryFiles('');
  const autoRestart = useAutoRestartOrchestrator();

  const identity = orchInfo!.identity!;
  const session = orchInfo?.session;
  const sessionId = orchInfo!.sessionId;

  const children = childrenQuery.data?.children ?? [];
  const totalCount = childrenQuery.data?.totalCount ?? 0;
  const hasMore = childrenQuery.data?.hasMore ?? false;

  // Selection state for bulk delete
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);

  // Clear selection when filter changes
  React.useEffect(() => {
    setSelectedIds(new Set());
  }, [hideTerminated]);

  // Compute uptime from doStatus
  const runningStartedAt = (doStatus as any)?.runningStartedAt as string | undefined;
  const [uptime, setUptime] = React.useState('');
  React.useEffect(() => {
    if (!runningStartedAt) {
      setUptime('');
      return;
    }
    const start = new Date(runningStartedAt).getTime();
    const tick = () => {
      const seconds = Math.floor((Date.now() - start) / 1000);
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      if (h > 0) setUptime(`${h}h ${m}m`);
      else setUptime(`${m}m`);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [runningStartedAt]);

  // Status label
  const statusLabel = !session
    ? 'Offline'
    : session.status === 'running' || session.status === 'idle'
      ? 'Online'
      : session.status === 'hibernated'
        ? 'Sleeping'
        : session.status;

  // Active count (derived from the non-filtered total or visible data)
  const activeCount = children.filter(
    (c) => c.status !== 'terminated' && c.status !== 'archived' && c.status !== 'error' && c.status !== 'hibernated'
  ).length;

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === children.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(children.map((c) => c.id)));
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title={identity.name}
        description={`@${identity.handle}`}
        actions={
          <div className="flex items-center gap-2">
            {autoRestart.needsRestart && (
              autoRestart.isRestarting ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-700 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                  Restarting...
                </span>
              ) : autoRestart.restartFailed ? (
                <button
                  onClick={autoRestart.retry}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-700 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50"
                >
                  Restart failed — Retry
                </button>
              ) : null
            )}
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId }}
              className="inline-flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Open Chat
            </Link>
          </div>
        }
      />

      {/* Status bar */}
      <div className="mb-6 flex flex-wrap items-center gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800">
        <div className="flex items-center gap-2">
          <StatusDot status={session?.status ?? 'terminated'} />
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {statusLabel}
          </span>
        </div>
        {uptime && (
          <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <span>Uptime:</span>
            <span className="font-mono tabular-nums">{uptime}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <span>Total sessions:</span>
          <span className="font-mono font-medium tabular-nums">{totalCount}</span>
        </div>
        {activeCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <span>Active:</span>
            <span className="font-mono font-medium tabular-nums text-green-600 dark:text-green-400">{activeCount}</span>
          </div>
        )}
      </div>

      <div className="space-y-8">
        {/* Managed Sessions */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              Managed Sessions
            </h2>
            <div className="flex items-center gap-2">
              {selectedIds.size > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowDeleteDialog(true)}
                  className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                >
                  Delete {selectedIds.size} selected
                </Button>
              )}
              <button
                onClick={() => setHideTerminated((prev) => !prev)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  hideTerminated
                    ? 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
                    : 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                }`}
              >
                {hideTerminated ? 'Show terminated' : 'Hide terminated'}
              </button>
            </div>
          </div>

          {children.length === 0 ? (
            <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center dark:border-neutral-700 dark:bg-neutral-800">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {hideTerminated ? 'No active sessions' : 'No managed sessions yet'}
              </p>
            </div>
          ) : (
            <>
              <ManagedSessionsTable
                sessions={children}
                selectedIds={selectedIds}
                onToggleSelection={toggleSelection}
                onToggleAll={toggleAll}
              />
              <LoadMoreButton
                onClick={() => childrenQuery.fetchNextPage()}
                isLoading={childrenQuery.isFetchingNextPage}
                hasMore={hasMore}
              />
            </>
          )}

          <BulkDeleteDialog
            sessionIds={Array.from(selectedIds)}
            open={showDeleteDialog}
            onOpenChange={setShowDeleteDialog}
            onDeleted={() => {
              setSelectedIds(new Set());
              childrenQuery.refetch();
            }}
          />
        </section>

        {/* Memory Files */}
        <section aria-label="Memory Files">
          <MemoryExplorer files={memoryFiles ?? []} />
        </section>
      </div>
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Managed Sessions Table
// ---------------------------------------------------------------------------

function ManagedSessionsTable({
  sessions,
  selectedIds,
  onToggleSelection,
  onToggleAll,
}: {
  sessions: ChildSessionSummaryWithRuntime[];
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onToggleAll: () => void;
}) {
  const allSelected = sessions.length > 0 && selectedIds.size === sessions.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < sessions.length;

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/50">
            <th className="w-10 px-3 py-2.5">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onChange={onToggleAll}
                aria-label="Select all sessions"
              />
            </th>
            <th className="px-3 py-2.5 text-left font-medium text-neutral-500 dark:text-neutral-400">
              Session
            </th>
            <th className="px-3 py-2.5 text-left font-medium text-neutral-500 dark:text-neutral-400">
              Status
            </th>
            <th className="hidden px-3 py-2.5 text-left font-medium text-neutral-500 dark:text-neutral-400 md:table-cell">
              Created
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {sessions.map((s) => (
            <ManagedSessionRow
              key={s.id}
              session={s}
              selected={selectedIds.has(s.id)}
              onToggle={() => onToggleSelection(s.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ManagedSessionRow({
  session,
  selected,
  onToggle,
}: {
  session: ChildSessionSummaryWithRuntime;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="bg-white transition-colors hover:bg-neutral-50 dark:bg-neutral-900 dark:hover:bg-neutral-800/50">
      <td className="w-10 px-3 py-2.5">
        <Checkbox
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${session.title || session.workspace}`}
        />
      </td>
      <td className="px-3 py-2.5">
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          className="flex items-center gap-2 font-medium text-neutral-900 transition-colors hover:text-accent dark:text-neutral-100 dark:hover:text-accent"
        >
          <StatusDot status={session.status} />
          <span className="truncate">{session.title || session.workspace}</span>
        </Link>
      </td>
      <td className="px-3 py-2.5">
        <Badge variant={STATUS_VARIANTS[session.status] ?? 'default'}>
          {session.status}
        </Badge>
      </td>
      <td className="hidden px-3 py-2.5 text-neutral-500 tabular-nums dark:text-neutral-400 md:table-cell">
        {formatRelativeTime(session.createdAt)}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function OrchestratorSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div>
        <Skeleton className="mb-3 h-5 w-36" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

