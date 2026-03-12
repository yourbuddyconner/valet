import { useState, useEffect, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useSession, useSessionChildren, useSessionDoStatus, useDeleteAnySessionTunnel } from '@/api/sessions';
import { useOrchestratorInfo, useMemoryFiles, useMemoryFile } from '@/api/orchestrator';
import { SidebarSection, StatusDot } from './session-metadata-sidebar';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ConnectedUser } from '@/hooks/use-chat';
import type { PRState } from '@/api/types';
import {
  deriveRuntimeStates,
  isAgentRuntimeState,
  isSandboxRuntimeState,
  isJointRuntimeState,
} from '@/lib/runtime-state';

interface OrchestratorMetadataSidebarProps {
  sessionId: string;
  connectedUsers?: ConnectedUser[];
  selectedModel?: string;
  compact?: boolean;
  embedded?: boolean;
}

const MAX_CHILDREN_SHOWN = 5;
const MAX_OPEN_PRS_SHOWN = 6;
const MAX_CHILD_TUNNELS_SHOWN = 8;

export function OrchestratorMetadataSidebar({
  sessionId,
  connectedUsers,
  compact = false,
  embedded = false,
}: OrchestratorMetadataSidebarProps) {
  const { data: session } = useSession(sessionId);
  const { data: doStatus } = useSessionDoStatus(sessionId);
  const { data: orchInfo } = useOrchestratorInfo();
  const { data: childSessions } = useSessionChildren(sessionId);
  const { data: memoryFiles } = useMemoryFiles('');
  const deleteTunnel = useDeleteAnySessionTunnel(sessionId);

  const runningStartedAt = typeof doStatus?.runningStartedAt === 'number' ? doStatus.runningStartedAt : null;
  const sandboxId = typeof doStatus?.sandboxId === 'string' && doStatus.sandboxId.length > 0
    ? doStatus.sandboxId
    : null;
  const runnerConnected = doStatus?.runnerConnected === true;
  const runnerBusy = doStatus?.runnerBusy === true;
  const queuedPrompts = typeof doStatus?.queuedPrompts === 'number' ? doStatus.queuedPrompts : 0;
  const lifecycleStatusInput = typeof doStatus?.lifecycleStatus === 'string'
    ? doStatus.lifecycleStatus
    : (typeof doStatus?.status === 'string' ? doStatus.status : session?.status ?? 'terminated');
  const derivedRuntime = useMemo(
    () =>
      deriveRuntimeStates({
        lifecycleStatus: lifecycleStatusInput,
        sandboxId,
        runnerConnected,
        runnerBusy,
        queuedPrompts,
      }),
    [lifecycleStatusInput, sandboxId, runnerConnected, runnerBusy, queuedPrompts],
  );
  const agentRuntimeState = isAgentRuntimeState(doStatus?.agentState)
    ? doStatus.agentState
    : derivedRuntime.agentState;
  const sandboxRuntimeState = isSandboxRuntimeState(doStatus?.sandboxState)
    ? doStatus.sandboxState
    : derivedRuntime.sandboxState;
  const jointRuntimeState = isJointRuntimeState(doStatus?.jointState)
    ? doStatus.jointState
    : derivedRuntime.jointState;

  const baseActiveSeconds = session?.activeSeconds ?? 0;
  const [elapsed, setElapsed] = useState(0);
  const [pendingTunnelKey, setPendingTunnelKey] = useState<string | null>(null);
  const [copiedPrKey, setCopiedPrKey] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      // Cumulative active time from D1 + current running period delta
      let totalSeconds = baseActiveSeconds;
      if (runningStartedAt) {
        totalSeconds += Math.floor((Date.now() - runningStartedAt) / 1000);
      }
      setElapsed(totalSeconds);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [runningStartedAt, baseActiveSeconds]);

  const identity = orchInfo?.identity;
  const nonTerminalChildren = useMemo(
    () =>
      (childSessions ?? []).filter((c) => {
        return c.status !== 'terminated' && c.status !== 'archived' && c.status !== 'error';
      }),
    [childSessions],
  );
  const activeChildren = useMemo(
    () => nonTerminalChildren.filter((c) => c.status !== 'hibernated'),
    [nonTerminalChildren],
  );
  const hibernatedChildren = useMemo(
    () => nonTerminalChildren.filter((c) => c.status === 'hibernated'),
    [nonTerminalChildren],
  );
  const openPRChildren = useMemo(
    () =>
      (childSessions ?? []).filter(
        (c) => c.prState === 'open' && typeof c.prNumber === 'number'
      ),
    [childSessions],
  );
  const childTunnels = useMemo(
    () =>
      nonTerminalChildren.flatMap((child) =>
        (child.tunnels ?? []).map((tunnel) => ({
          childId: child.id,
          childTitle: child.title || child.workspace,
          name: tunnel.name,
          url: tunnel.url,
          path: tunnel.path,
        }))
      ),
    [nonTerminalChildren],
  );

  const totalMemoryFiles = memoryFiles?.length ?? 0;
  const pinnedCount = useMemo(() => (memoryFiles ?? []).filter((f) => f.pinned).length, [memoryFiles]);
  const recentFiles = useMemo(() => {
    if (!memoryFiles || memoryFiles.length === 0) return [];
    return [...memoryFiles]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 4);
  }, [memoryFiles]);

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const copyPrLink = async (prKey: string, prUrl: string) => {
    try {
      await navigator.clipboard.writeText(prUrl);
      setCopiedPrKey(prKey);
      setTimeout(() => {
        setCopiedPrKey((current) => (current === prKey ? null : current));
      }, 1500);
    } catch {
      // Ignore clipboard failures silently to keep the sidebar lightweight.
    }
  };

  const agentStatusRaw = (() => {
    switch (agentRuntimeState) {
      case 'busy':
      case 'idle':
        return 'running';
      case 'queued':
      case 'starting':
        return 'initializing';
      case 'sleeping':
        return 'hibernated';
      case 'standby':
      case 'stopped':
        return 'terminated';
      case 'error':
        return 'error';
    }
  })();
  const agentStatusLabel = (() => {
    if (jointRuntimeState === 'waking') return 'Waking';
    switch (agentRuntimeState) {
      case 'busy':
        return 'Running (busy)';
      case 'idle':
        return 'Running (idle)';
      case 'queued':
        return sandboxRuntimeState === 'running' ? 'Queued' : 'Waking (queued)';
      case 'starting':
        return 'Starting';
      case 'sleeping':
        return 'Sleeping';
      case 'standby':
        return sandboxRuntimeState === 'running'
          ? 'Standby (runner offline)'
          : 'Standby (no sandbox)';
      case 'stopped':
        return 'Stopped';
      case 'error':
        return 'Error';
    }
  })();

  const sandboxStatusRaw = (() => {
    switch (sandboxRuntimeState) {
      case 'running':
        return 'running';
      case 'starting':
      case 'restoring':
      case 'hibernating':
        return 'initializing';
      case 'hibernated':
        return 'hibernated';
      case 'stopped':
        return 'terminated';
      case 'error':
        return 'error';
    }
  })();
  const sandboxStatusLabel = (() => {
    switch (sandboxRuntimeState) {
      case 'running':
        return 'Running';
      case 'starting':
        return 'Starting';
      case 'restoring':
        return 'Restoring';
      case 'hibernating':
        return 'Hibernating';
      case 'hibernated':
        return 'Sleeping';
      case 'stopped':
        return 'Not running';
      case 'error':
        return 'Error';
    }
  })();

  return (
    <div
      className={`metadata-sidebar flex h-full flex-col bg-surface-0 dark:bg-surface-0 ${embedded ? 'w-full' : `border-l border-border ${compact ? 'w-[200px]' : 'w-[240px]'}`}`}
    >
      {!embedded && (
        <>
          <div className={`flex h-10 shrink-0 items-center border-b border-border ${compact ? 'px-2' : 'px-3'}`}>
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-neutral-400 dark:text-neutral-500">
              Orchestrator
            </span>
          </div>
          <div className={`flex h-8 shrink-0 items-center border-b border-neutral-100 dark:border-neutral-800/50 ${compact ? 'px-2' : 'px-3'}`} />
        </>
      )}

      <div className={`metadata-scroll flex-1 overflow-y-auto ${embedded ? 'px-3 py-3 space-y-3' : (compact ? 'px-2 py-2 space-y-2' : 'px-3 py-2.5 space-y-3')}`}>
        {/* Identity */}
        <SidebarSection label="Identity">
          <div className="flex items-center gap-2">
            {identity?.avatar ? (
              <img src={identity.avatar} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
            ) : (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 font-mono text-[11px] font-bold text-accent">
                {identity?.name?.[0]?.toUpperCase() ?? '?'}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px] font-medium text-neutral-700 dark:text-neutral-200">
                {identity?.name ?? 'Orchestrator'}
              </div>
              {identity?.handle && (
                <div className="truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                  @{identity.handle}
                </div>
              )}
            </div>
          </div>
          <div className="mt-1.5 space-y-1">
            <div className="flex items-center gap-1.5">
              <StatusDot status={agentStatusRaw} />
              <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                Agent: {agentStatusLabel}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <StatusDot status={sandboxStatusRaw} />
              <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                Sandbox: {sandboxStatusLabel}
              </span>
            </div>
          </div>
        </SidebarSection>

        {/* Team */}
        {connectedUsers && connectedUsers.length > 0 && (
          <SidebarSection label="Team">
            <div className="flex flex-wrap gap-1">
              {connectedUsers.map((user) => (
                <span
                  key={user.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-neutral-100 bg-surface-1/50 px-2 py-px font-mono text-[10px] text-neutral-500 dark:border-neutral-800 dark:bg-surface-2/50 dark:text-neutral-400"
                >
                  <span className="h-1 w-1 rounded-full bg-emerald-500" />
                  {user.name || user.email || user.id.slice(0, 8)}
                </span>
              ))}
            </div>
          </SidebarSection>
        )}

        {/* Sandbox Uptime */}
        <SidebarSection label="Sandbox Uptime">
          <span className="font-mono text-[11px] font-medium text-neutral-600 dark:text-neutral-300 tabular-nums">
            {elapsed > 0 ? formatDuration(elapsed) : '\u2014'}
          </span>
        </SidebarSection>

        {/* Thread History */}
        <SidebarSection label="Threads">
          <Link
            to="/sessions/$sessionId/threads"
            params={{ sessionId }}
            className="inline-flex items-center gap-1.5 rounded-sm border border-border/60 bg-surface-1/40 px-2 py-1 font-mono text-[10px] text-neutral-600 transition-colors hover:bg-surface-1 hover:text-accent dark:bg-surface-2/40 dark:text-neutral-400 dark:hover:bg-surface-2 dark:hover:text-accent"
          >
            Thread History
          </Link>
        </SidebarSection>

        {/* Child Sessions */}
        {nonTerminalChildren.length > 0 && (
          <SidebarSection
            label={`Sessions (${activeChildren.length} active · ${hibernatedChildren.length} hibernated)`}
          >
            <div className="space-y-1">
              {activeChildren.concat(hibernatedChildren).slice(0, MAX_CHILDREN_SHOWN).map((child) => (
                <Link
                  key={child.id}
                  to="/sessions/$sessionId"
                  params={{ sessionId: child.id }}
                  className="group/child flex items-center gap-1.5 rounded-sm border border-border/60 bg-surface-1/40 px-1.5 py-1 transition-colors hover:bg-surface-1 dark:bg-surface-2/40 dark:hover:bg-surface-2"
                >
                  <StatusDot status={child.status} />
                  <span className="truncate font-mono text-[10px] text-neutral-600 transition-colors group-hover/child:text-neutral-900 dark:text-neutral-300 dark:group-hover/child:text-neutral-100">
                    {child.title || child.workspace}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[8px] uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
                    {child.status === 'hibernated' ? 'hibernated' : 'active'}
                  </span>
                </Link>
              ))}
              {nonTerminalChildren.length > MAX_CHILDREN_SHOWN && (
                <span className="block px-1.5 font-mono text-[9px] text-neutral-400 dark:text-neutral-500">
                  +{nonTerminalChildren.length - MAX_CHILDREN_SHOWN} more
                </span>
              )}
            </div>
          </SidebarSection>
        )}

        {/* Open Pull Requests */}
        {openPRChildren.length > 0 && (
          <SidebarSection label={`Open PRs (${openPRChildren.length})`}>
            <div className="space-y-1">
              {openPRChildren.slice(0, MAX_OPEN_PRS_SHOWN).map((child) => {
                const prKey = `${child.id}:pr:${child.prNumber}`;
                const copied = copiedPrKey === prKey;
                const prUrl = child.prUrl ?? null;
                return (
                  <div
                    key={prKey}
                    className="rounded-sm border border-border/60 bg-surface-1/40 px-1.5 py-1 dark:bg-surface-2/40"
                  >
                    <div className="flex items-center gap-1.5">
                      <ChildPRStateBadge state={child.prState ?? null} />
                      <span className="font-mono text-[9px] text-neutral-500 dark:text-neutral-400">
                        #{child.prNumber}
                      </span>
                      {prUrl && (
                        <button
                          type="button"
                          onClick={() => void copyPrLink(prKey, prUrl)}
                          className="ml-auto rounded-sm border border-border/70 bg-surface-1 px-1.5 py-[1px] font-mono text-[8px] uppercase tracking-[0.06em] text-neutral-600 transition-colors hover:text-accent dark:bg-surface-2 dark:text-neutral-400 dark:hover:text-accent"
                          title="Copy PR link"
                        >
                          {copied ? 'Copied' : 'Copy'}
                        </button>
                      )}
                    </div>
                    {prUrl ? (
                      <a
                        href={prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 block truncate font-mono text-[10px] text-neutral-600 transition-colors hover:text-accent dark:text-neutral-300 dark:hover:text-accent"
                      >
                        {child.prTitle || `Pull request #${child.prNumber}`}
                      </a>
                    ) : (
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-neutral-600 dark:text-neutral-300">
                        {child.prTitle || `Pull request #${child.prNumber}`}
                      </span>
                    )}
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: child.id }}
                      className="mt-0.5 block truncate font-mono text-[8px] uppercase tracking-[0.06em] text-neutral-400 transition-colors hover:text-accent dark:text-neutral-500 dark:hover:text-accent"
                    >
                      Session: {child.title || child.workspace}
                    </Link>
                  </div>
                );
              })}
              {openPRChildren.length > MAX_OPEN_PRS_SHOWN && (
                <span className="block px-1.5 font-mono text-[9px] text-neutral-400 dark:text-neutral-500">
                  +{openPRChildren.length - MAX_OPEN_PRS_SHOWN} more
                </span>
              )}
            </div>
          </SidebarSection>
        )}

        {/* Child Tunnels */}
        {childTunnels.length > 0 && (
          <SidebarSection label={`Tunnels (${childTunnels.length})`}>
            <div className="space-y-1">
              {childTunnels.slice(0, MAX_CHILD_TUNNELS_SHOWN).map((tunnel) => {
                const tunnelKey = `${tunnel.childId}:${tunnel.name}`;
                const isPending = deleteTunnel.isPending && pendingTunnelKey === tunnelKey;
                return (
                  <div
                    key={`${tunnelKey}:${tunnel.path ?? ''}`}
                    className="rounded-sm border border-border/60 bg-surface-1/40 px-1.5 py-1 dark:bg-surface-2/40"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-[9px] uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
                        {tunnel.name}
                      </span>
                      {tunnel.url && (
                        <a
                          href={tunnel.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto rounded-sm border border-border/70 bg-surface-1 px-1.5 py-[1px] font-mono text-[8px] text-neutral-600 transition-colors hover:text-accent dark:bg-surface-2 dark:text-neutral-400 dark:hover:text-accent"
                        >
                          Open
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setPendingTunnelKey(tunnelKey);
                          deleteTunnel.mutate(
                            { sessionId: tunnel.childId, name: tunnel.name },
                            { onSettled: () => setPendingTunnelKey(null) }
                          );
                        }}
                        disabled={isPending}
                        className="rounded-sm border border-border/70 bg-surface-1 px-1.5 py-[1px] font-mono text-[8px] text-neutral-600 transition-colors hover:text-red-500 disabled:opacity-50 dark:bg-surface-2 dark:text-neutral-400 dark:hover:text-red-400"
                      >
                        {isPending ? '...' : 'Off'}
                      </button>
                    </div>
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: tunnel.childId }}
                      className="mt-0.5 block truncate font-mono text-[9px] text-neutral-500 transition-colors hover:text-accent dark:text-neutral-400 dark:hover:text-accent"
                    >
                      {tunnel.childTitle}
                    </Link>
                    <div className="mt-0.5 truncate font-mono text-[9px] text-neutral-400 dark:text-neutral-500">
                      {tunnel.url || tunnel.path || 'tunnel'}
                    </div>
                  </div>
                );
              })}
              {childTunnels.length > MAX_CHILD_TUNNELS_SHOWN && (
                <span className="block px-1.5 font-mono text-[9px] text-neutral-400 dark:text-neutral-500">
                  +{childTunnels.length - MAX_CHILD_TUNNELS_SHOWN} more
                </span>
              )}
            </div>
          </SidebarSection>
        )}

        {/* Memory Files */}
        {totalMemoryFiles > 0 && (
          <SidebarSection label={`Memory (${totalMemoryFiles} files, ${pinnedCount} pinned)`}>
            <TooltipProvider delayDuration={400}>
              <div className="space-y-1">
                {recentFiles.map((file) => (
                  <MemoryFileTooltip key={file.path} file={file} />
                ))}
              </div>
            </TooltipProvider>
          </SidebarSection>
        )}
      </div>
    </div>
  );
}

function MemoryFileTooltip({ file }: { file: { path: string; pinned: boolean } }) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <div className="flex cursor-default items-start gap-1.5 rounded-sm px-1 py-0.5 transition-colors hover:bg-surface-1 dark:hover:bg-surface-2">
          {file.pinned && (
            <Badge className="mt-px shrink-0 !px-1 !py-0 !text-[8px] !tracking-normal bg-violet-500/10 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400">
              pin
            </Badge>
          )}
          <span className="line-clamp-1 font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
            {file.path}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        align="start"
        sideOffset={8}
        className="max-h-[300px] max-w-[360px] overflow-hidden rounded-lg border border-border bg-surface-0 p-0 text-neutral-800 shadow-lg dark:bg-surface-1 dark:text-neutral-200"
      >
        {open && <MemoryFilePreview path={file.path} />}
      </TooltipContent>
    </Tooltip>
  );
}

function MemoryFilePreview({ path }: { path: string }) {
  const { data, isLoading, isError } = useMemoryFile(path);

  const fileName = path.split('/').pop() ?? path;

  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-3 py-1.5">
        <span className="font-mono text-[10px] font-medium text-neutral-600 dark:text-neutral-300">
          {fileName}
        </span>
        <span className="ml-1.5 font-mono text-[9px] text-neutral-400 dark:text-neutral-500">
          {path}
        </span>
      </div>
      <div className="max-h-[260px] overflow-y-auto px-3 py-2">
        {isLoading && (
          <div className="flex items-center gap-2 py-2">
            <div className="h-3 w-3 animate-spin rounded-full border border-neutral-300 border-t-transparent dark:border-neutral-600 dark:border-t-transparent" />
            <span className="font-mono text-[10px] text-neutral-400">Loading...</span>
          </div>
        )}
        {isError && (
          <span className="font-mono text-[10px] text-red-500">Failed to load</span>
        )}
        {!isLoading && !isError && data && data.content.length > 0 && (
          <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-neutral-600 dark:text-neutral-300">
            {data.content.length > 1500 ? data.content.slice(0, 1500) + '\n...' : data.content}
          </pre>
        )}
        {!isLoading && !isError && (!data || data.content.length === 0) && (
          <span className="font-mono text-[10px] text-neutral-400">Empty file</span>
        )}
      </div>
    </div>
  );
}

function ChildPRStateBadge({ state }: { state: PRState | null }) {
  if (!state) return null;
  const variants: Record<string, 'default' | 'success' | 'warning' | 'error' | 'secondary'> = {
    draft: 'secondary',
    open: 'success',
    closed: 'error',
    merged: 'default',
  };
  return <Badge variant={variants[state] ?? 'default'}>{state}</Badge>;
}
