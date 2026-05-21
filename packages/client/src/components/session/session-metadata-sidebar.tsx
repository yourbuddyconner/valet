import { useState, useEffect, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useSession, useSessionGitState, useSessionChildren, useSessionFilesChanged, useSessionDoStatus, useDeleteSessionTunnel } from '@/api/sessions';
import { useDrawer } from '@/hooks/use-drawer';
import { Badge } from '@/components/ui/badge';
import type { PRState, SessionFileChanged } from '@/api/types';
import type { ConnectedUser } from '@/hooks/use-chat';
import {
  deriveRuntimeStates,
  isAgentRuntimeState,
  isSandboxRuntimeState,
  isJointRuntimeState,
} from '@/lib/runtime-state';

interface SessionMetadataSidebarProps {
  sessionId: string;
  connectedUsers?: ConnectedUser[];
  selectedModel?: string;
  compact?: boolean;
  embedded?: boolean;
}

export function SessionMetadataSidebar({ sessionId, connectedUsers, selectedModel, compact = false, embedded = false }: SessionMetadataSidebarProps) {
  const { data: session } = useSession(sessionId);
  const { data: doStatus } = useSessionDoStatus(sessionId);

  const { data: gitState } = useSessionGitState(sessionId);
  const { data: childSessions } = useSessionChildren(sessionId);
  const { data: filesChanged } = useSessionFilesChanged(sessionId);
  const { data: parentSession } = useSession(session?.parentSessionId ?? '', );
  const deleteTunnel = useDeleteSessionTunnel(sessionId);

  const runningStartedAt = typeof doStatus?.runningStartedAt === 'number' ? doStatus.runningStartedAt : null;
  const baseActiveSeconds = session?.activeSeconds ?? 0;
  const [elapsed, setElapsed] = useState(0);

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

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const activeChildren = (childSessions ?? []).filter((c) => c.status !== 'terminated' && c.status !== 'archived' && c.status !== 'error');
  const tunnels = Array.isArray((doStatus as { tunnels?: unknown })?.tunnels)
    ? ((doStatus as { tunnels: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }> }).tunnels || [])
    : [];
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
  const lifecycleRuntimeState = derivedRuntime.lifecycleStatus;
  const agentRuntimeState = isAgentRuntimeState(doStatus?.agentState)
    ? doStatus.agentState
    : derivedRuntime.agentState;
  const sandboxRuntimeState = isSandboxRuntimeState(doStatus?.sandboxState)
    ? doStatus.sandboxState
    : derivedRuntime.sandboxState;
  const jointRuntimeState = isJointRuntimeState(doStatus?.jointState)
    ? doStatus.jointState
    : derivedRuntime.jointState;

  const lifecycleStatusRaw = (() => {
    switch (lifecycleRuntimeState) {
      case 'running':
        return 'running';
      case 'idle':
        return 'idle';
      case 'hibernated':
        return 'hibernated';
      case 'terminated':
      case 'archived':
        return 'terminated';
      case 'error':
        return 'error';
      case 'initializing':
      case 'hibernating':
      case 'restoring':
      case 'waiting_runner':
      case 'recovering':
        return 'initializing';
      case 'backoff':
        return 'error';
      default:
        return 'initializing';
    }
  })();
  const lifecycleStatusLabel = (() => {
    switch (lifecycleRuntimeState) {
      case 'initializing':
        return 'Initializing';
      case 'running':
        return 'Running';
      case 'idle':
        return 'Idle';
      case 'hibernating':
        return 'Hibernating';
      case 'hibernated':
        return 'Sleeping';
      case 'restoring':
        return 'Restoring';
      case 'terminated':
        return 'Terminated';
      case 'archived':
        return 'Archived';
      case 'error':
        return 'Error';
    }
  })();

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
    <div className={`metadata-sidebar flex h-full flex-col bg-surface-0 dark:bg-surface-0 ${embedded ? 'w-full' : `border-l border-border ${compact ? 'w-[200px]' : 'w-[240px]'}`}`}>
      {!embedded && (
        <>
          <div className={`flex h-10 shrink-0 items-center border-b border-border ${compact ? 'px-2' : 'px-3'}`}>
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-neutral-400 dark:text-neutral-500">
              Session Info
            </span>
          </div>
          <div className={`flex h-8 shrink-0 items-center border-b border-neutral-100 dark:border-neutral-800/50 ${compact ? 'px-2' : 'px-3'}`} />
        </>
      )}

      <div className={`metadata-scroll flex-1 overflow-y-auto ${embedded ? 'px-3 py-3 space-y-3' : (compact ? 'px-2 py-2 space-y-2' : 'px-3 py-2.5 space-y-3')}`}>
        {/* Connected Users */}
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

        {/* Runtime */}
        <SidebarSection label="Runtime">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <StatusDot status={lifecycleStatusRaw} />
              <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                Lifecycle: {lifecycleStatusLabel}
              </span>
            </div>
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
            {sandboxId && (
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                  Sandbox ID:
                </span>
                <CopyableText text={sandboxId} />
              </div>
            )}
          </div>
        </SidebarSection>

        {/* Duration */}
        <SidebarSection label="Duration">
          <span className="font-mono text-[11px] font-medium text-neutral-600 dark:text-neutral-300 tabular-nums">
            {formatDuration(elapsed)}
          </span>
        </SidebarSection>

        {/* Model */}
        {selectedModel && (
          <SidebarSection label="Model">
            <span className="inline-flex rounded-sm bg-surface-2/60 px-1.5 py-px font-mono text-[10px] font-medium text-neutral-600 dark:bg-surface-2 dark:text-neutral-400">
              {selectedModel}
            </span>
          </SidebarSection>
        )}

        {/* Tunnels */}
        {tunnels.length > 0 && (
          <SidebarSection label={`Tunnels (${tunnels.length})`}>
            <div className="space-y-2">
              {tunnels.map((tunnel) => (
                <div
                  key={tunnel.name}
                  className="min-w-0 overflow-hidden rounded-md border border-border/60 bg-surface-1/40 px-2 py-1.5 dark:bg-surface-2/40"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-neutral-400 dark:text-neutral-500">
                      {tunnel.name}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {tunnel.url && (
                        <a
                          href={tunnel.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-sm border border-border/70 bg-surface-1 px-2 py-[2px] font-mono text-[9px] text-neutral-600 transition-colors hover:text-accent dark:bg-surface-2 dark:text-neutral-400 dark:hover:text-accent"
                        >
                          Open
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => deleteTunnel.mutate(tunnel.name)}
                        className="rounded-sm border border-border/70 bg-surface-1 px-2 py-[2px] font-mono text-[9px] text-neutral-600 transition-colors hover:text-red-500 dark:bg-surface-2 dark:text-neutral-400 dark:hover:text-red-400"
                        disabled={deleteTunnel.isPending}
                      >
                        Off
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 min-w-0 overflow-hidden">
                    <CopyableText text={tunnel.url || tunnel.path || `/t/${tunnel.name}`} />
                  </div>
                </div>
              ))}
            </div>
          </SidebarSection>
        )}

        {/* Repository */}
        {(gitState?.sourceRepoFullName || session?.workspace) && (
          <SidebarSection label="Repository">
            {gitState?.sourceRepoUrl ? (
              <a
                href={gitState.sourceRepoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group/repo flex items-center gap-1.5 font-mono text-[11px] text-neutral-600 transition-colors hover:text-accent dark:text-neutral-400 dark:hover:text-accent"
              >
                <GitHubIcon className="h-3 w-3 shrink-0 text-neutral-400 transition-colors group-hover/repo:text-accent dark:text-neutral-500" />
                <span className="truncate">{gitState.sourceRepoFullName || session?.workspace}</span>
              </a>
            ) : (
              <span className="font-mono text-[11px] text-neutral-600 dark:text-neutral-400">
                {gitState?.sourceRepoFullName || session?.workspace}
              </span>
            )}
          </SidebarSection>
        )}

        {/* PR Status */}
        {gitState?.prNumber && (
          <SidebarSection label="Pull Request">
            <div className="flex items-center gap-1.5">
              <PRStateBadge state={gitState.prState} />
              {gitState.prUrl ? (
                <a
                  href={gitState.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[11px] text-neutral-600 transition-colors hover:text-accent truncate dark:text-neutral-400 dark:hover:text-accent"
                >
                  #{gitState.prNumber} {gitState.prTitle}
                </a>
              ) : (
                <span className="font-mono text-[11px] text-neutral-600 dark:text-neutral-400 truncate">
                  #{gitState.prNumber} {gitState.prTitle}
                </span>
              )}
            </div>
          </SidebarSection>
        )}

        {/* Branch */}
        {gitState?.branch && (
          <SidebarSection label="Branch">
            <div className="flex items-center gap-1.5">
              <BranchIcon className="h-2.5 w-2.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
              <CopyableText text={gitState.branch} />
            </div>
            {gitState.baseBranch && (
              <span className="mt-0.5 ml-4 block font-mono text-[9px] text-neutral-400 dark:text-neutral-600">
                from {gitState.baseBranch}
              </span>
            )}
          </SidebarSection>
        )}

        {/* Parent Session */}
        {session?.parentSessionId && (
          <SidebarSection label="Parent Session">
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: session.parentSessionId }}
              className="group/parent flex items-center gap-1.5 rounded-sm px-1.5 py-1 transition-colors hover:bg-surface-1 dark:hover:bg-surface-2"
            >
              <ArrowUpIcon className="h-2.5 w-2.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
              <span className="truncate font-mono text-[10px] text-neutral-600 transition-colors group-hover/parent:text-neutral-900 dark:text-neutral-400 dark:group-hover/parent:text-neutral-200">
                {parentSession?.title || parentSession?.workspace || session.parentSessionId.slice(0, 8)}
              </span>
            </Link>
          </SidebarSection>
        )}

        {/* Child Sessions (hide terminated/error) */}
        {activeChildren.length > 0 && (
          <SidebarSection label={`Sub-agents (${activeChildren.length})`}>
            <div className="space-y-px">
              {activeChildren.map((child) => (
                <Link
                  key={child.id}
                  to="/sessions/$sessionId"
                  params={{ sessionId: child.id }}
                  className="group/child flex items-center gap-1.5 rounded-sm px-1.5 py-1 transition-colors hover:bg-surface-1 dark:hover:bg-surface-2"
                >
                  <StatusDot status={child.status} />
                  <span className="truncate font-mono text-[10px] text-neutral-600 transition-colors group-hover/child:text-neutral-900 dark:text-neutral-400 dark:group-hover/child:text-neutral-200">
                    {child.title || child.workspace}
                  </span>
                </Link>
              ))}
            </div>
          </SidebarSection>
        )}

        {/* Files Changed */}
        {filesChanged && filesChanged.length > 0 && (
          <SidebarSection label={`Files (${filesChanged.length})`}>
            <div className="space-y-0">
              {filesChanged.map((file) => (
                <FileChangedItem key={file.id} file={file} />
              ))}
            </div>
          </SidebarSection>
        )}

        {/* Source context */}
        {gitState?.sourceType === 'issue' && gitState.sourceIssueNumber && (
          <SidebarSection label="Source">
            <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-500">
              Issue #{gitState.sourceIssueNumber}
            </span>
          </SidebarSection>
        )}
        {gitState?.sourceType === 'pr' && gitState.sourcePrNumber && (
          <SidebarSection label="Source">
            <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-500">
              PR #{gitState.sourcePrNumber}
            </span>
          </SidebarSection>
        )}

        {/* Stats */}
        {gitState?.commitCount != null && gitState.commitCount > 0 && (
          <SidebarSection label="Stats">
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              <StatItem label="Commits" value={gitState.commitCount} />
            </div>
          </SidebarSection>
        )}
      </div>
    </div>
  );
}

function FileChangedItem({ file }: { file: SessionFileChanged }) {
  const { openFile } = useDrawer();
  const statusColors: Record<string, string> = {
    added: 'text-emerald-600 dark:text-emerald-400',
    modified: 'text-amber-600 dark:text-amber-400',
    deleted: 'text-red-500 dark:text-red-400',
    renamed: 'text-blue-500 dark:text-blue-400',
  };

  const fileName = file.filePath.split('/').pop() || file.filePath;

  return (
    <button
      type="button"
      onClick={() => openFile(file.filePath)}
      className="group/file flex w-full items-center gap-1.5 rounded-sm px-1 py-[3px] text-left transition-colors hover:bg-surface-1 dark:hover:bg-surface-2 cursor-pointer"
      title={file.filePath}
    >
      <span className={`shrink-0 font-mono text-[9px] font-bold leading-none ${statusColors[file.status] ?? 'text-neutral-400'}`}>
        {file.status[0].toUpperCase()}
      </span>
      <span className="truncate font-mono text-[10px] text-neutral-600 dark:text-neutral-400">
        {fileName}
      </span>
      {(file.additions > 0 || file.deletions > 0) && (
        <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums opacity-60 group-hover/file:opacity-100 transition-opacity">
          {file.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>}
          {file.additions > 0 && file.deletions > 0 && ' '}
          {file.deletions > 0 && <span className="text-red-500 dark:text-red-400">-{file.deletions}</span>}
        </span>
      )}
    </button>
  );
}

export function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-emerald-400',
    initializing: 'bg-amber-400',
    restoring: 'bg-amber-400',
    hibernating: 'bg-amber-400',
    idle: 'bg-neutral-400',
    terminated: 'bg-neutral-300 dark:bg-neutral-600',
    stopped: 'bg-neutral-300 dark:bg-neutral-600',
    archived: 'bg-neutral-300 dark:bg-neutral-600',
    error: 'bg-red-400',
    hibernated: 'bg-neutral-300 dark:bg-neutral-600',
  };

  return (
    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colors[status] ?? 'bg-neutral-300'}`} />
  );
}

export function SidebarSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="metadata-section-label mb-1 block font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
        {label}
      </span>
      {children}
    </div>
  );
}

export function StatItem({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">{label}</span>
      <span className="font-mono text-[11px] font-semibold text-neutral-700 dark:text-neutral-300 tabular-nums">
        {value}
      </span>
    </div>
  );
}

export function CopyableText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      onClick={handleCopy}
      className="group/copy flex w-full min-w-0 items-center gap-1 overflow-hidden font-mono text-[11px] text-neutral-600 transition-colors hover:text-accent dark:text-neutral-400 dark:hover:text-accent"
      title="Click to copy"
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {copied ? (
        <CheckIcon className="h-2.5 w-2.5 shrink-0 text-emerald-500" />
      ) : (
        <CopyIcon className="h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-60" />
      )}
    </button>
  );
}

function PRStateBadge({ state }: { state: PRState | null }) {
  if (!state) return null;
  const variants: Record<string, 'default' | 'success' | 'warning' | 'error' | 'secondary'> = {
    draft: 'secondary',
    open: 'success',
    closed: 'error',
    merged: 'default',
  };
  return <Badge variant={variants[state] ?? 'default'}>{state}</Badge>;
}

function ArrowUpIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function BranchIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
