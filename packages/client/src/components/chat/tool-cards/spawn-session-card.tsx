import { Link } from '@tanstack/react-router';
import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { ForkIcon } from './icons';
import { useSession, useSessionFilesChanged, useSessionGitState } from '@/api/sessions';
import type { ToolCallData } from './types';

interface SpawnSessionArgs {
  task?: string;
  workspace?: string;
  title?: string;
  repo_url?: string;
  branch?: string;
  ref?: string;
}

/** UUID v4 pattern */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractChildSessionId(result: unknown): string | null {
  // Try string result first (live tool result)
  if (typeof result === 'string') {
    const namedMatch = result.match(/Child session spawned:\s*(\S+)/);
    if (namedMatch) return namedMatch[1];
    // Fall back to any UUID in the string
    const uuidMatch = result.match(UUID_RE);
    if (uuidMatch) return uuidMatch[0];
  }
  // Try object with childSessionId property
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (typeof obj.childSessionId === 'string') return obj.childSessionId;
  }
  return null;
}

export function SpawnSessionCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as SpawnSessionArgs;
  const childSessionId = extractChildSessionId(tool.result);
  const title = args.title || args.workspace || 'Child session';

  const summary = (
    <span className="text-neutral-500 dark:text-neutral-400">
      {title}
    </span>
  );

  return (
    <ToolCardShell
      icon={<ForkIcon className="h-3.5 w-3.5" />}
      label="spawn_session"
      status={tool.status}
      tool={tool}
      summary={summary}
    >
      <ToolCardSection>
        {/* Task description */}
        {args.task && (
          <div className="mb-2">
            <div className="mb-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
              task
            </div>
            <p className="font-mono text-[11px] leading-[1.6] text-neutral-600 dark:text-neutral-400">
              {args.task.length > 200 ? args.task.slice(0, 200) + '...' : args.task}
            </p>
          </div>
        )}

        {/* Child session details (live) */}
        {childSessionId && <ChildSessionDetail sessionId={childSessionId} />}

        {/* Show child session ID as fallback if not yet resolved */}
        {!childSessionId && tool.status === 'completed' && (
          <p className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
            {typeof tool.result === 'string' ? tool.result : 'Session spawned'}
          </p>
        )}
      </ToolCardSection>
    </ToolCardShell>
  );
}

function ChildSessionDetail({ sessionId }: { sessionId: string }) {
  const { data: session } = useSession(sessionId);
  const { data: filesChanged } = useSessionFilesChanged(sessionId);
  const { data: gitState } = useSessionGitState(sessionId);

  const totalAdditions = filesChanged?.reduce((sum, f) => sum + (f.additions ?? 0), 0) ?? 0;
  const totalDeletions = filesChanged?.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0;

  return (
    <div className="space-y-1.5 font-mono text-[11px]">
      {/* Status */}
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-neutral-400 dark:text-neutral-500">Status</span>
        <span className="flex items-center gap-1.5">
          <StatusDot status={session?.status} />
          <span className="text-neutral-600 dark:text-neutral-300">{session?.status ?? 'loading...'}</span>
        </span>
      </div>

      {/* Session ID + link */}
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-neutral-400 dark:text-neutral-500">Session</span>
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId }}
          className="text-accent hover:underline"
        >
          {sessionId.slice(0, 8)}...
          <span className="ml-1 text-[10px]">&rarr;</span>
        </Link>
      </div>

      {/* Workspace */}
      {session?.workspace && (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-neutral-400 dark:text-neutral-500">Workspace</span>
          <span className="text-neutral-600 dark:text-neutral-300">{session.workspace}</span>
        </div>
      )}

      {/* Branch */}
      {gitState?.branch && (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-neutral-400 dark:text-neutral-500">Branch</span>
          <span className="text-neutral-600 dark:text-neutral-300">{gitState.branch}</span>
        </div>
      )}

      {/* Ref */}
      {gitState?.ref && (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-neutral-400 dark:text-neutral-500">Ref</span>
          <span className="text-neutral-600 dark:text-neutral-300">{gitState.ref}</span>
        </div>
      )}

      {/* Files changed */}
      {filesChanged && filesChanged.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-neutral-400 dark:text-neutral-500">Files</span>
          <span className="text-neutral-600 dark:text-neutral-300">
            {filesChanged.length} changed
            {(totalAdditions > 0 || totalDeletions > 0) && (
              <span className="ml-1.5">
                {totalAdditions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{totalAdditions}</span>}
                {totalAdditions > 0 && totalDeletions > 0 && ' '}
                {totalDeletions > 0 && <span className="text-red-500 dark:text-red-400">-{totalDeletions}</span>}
              </span>
            )}
          </span>
        </div>
      )}

      {/* PR */}
      {gitState?.prNumber && (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-neutral-400 dark:text-neutral-500">PR</span>
          <span className="text-neutral-600 dark:text-neutral-300">
            {gitState.prUrl ? (
              <a href={gitState.prUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                #{gitState.prNumber}
              </a>
            ) : (
              `#${gitState.prNumber}`
            )}
            {gitState.prState && (
              <span className={`ml-1.5 rounded px-1 py-0.5 text-[9px] font-medium uppercase ${
                gitState.prState === 'merged'
                  ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                  : gitState.prState === 'closed'
                    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
              }`}>
                {gitState.prState}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status?: string }) {
  if (!status) return null;

  const isActive = status === 'running' || status === 'initializing' || status === 'restoring';
  const isError = status === 'error';

  if (isActive) {
    return (
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/50" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
    );
  }

  if (isError) {
    return <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />;
  }

  if (status === 'terminated' || status === 'archived' || status === 'hibernated') {
    return <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400" />;
  }

  return <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />;
}
