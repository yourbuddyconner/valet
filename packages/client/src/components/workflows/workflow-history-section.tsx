import * as React from 'react';
import {
  useWorkflowHistory,
  type WorkflowVersionHistoryEntry,
} from '@/api/workflows';
import { formatRelativeTime } from '@/lib/format';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RestoreVersionDialog } from './restore-version-dialog';
import { VersionViewDialog } from './version-view-dialog';
import { Skeleton } from '@/components/ui/skeleton';

type Source = WorkflowVersionHistoryEntry['source'];

// Map provenance source to a badge variant. Restores read as caution (warning),
// proposal applies are positive (success), everything else stays neutral.
const SOURCE_VARIANT: Record<Source, BadgeProps['variant']> = {
  sync: 'secondary',
  update: 'default',
  proposal_apply: 'success',
  rollback: 'warning',
  system: 'secondary',
};

const SOURCE_LABEL: Record<Source, string> = {
  sync: 'sync',
  update: 'update',
  proposal_apply: 'proposal',
  rollback: 'rollback',
  system: 'system',
};

const INITIAL_VISIBLE = 5;

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

interface Props {
  workflowId: string;
}

export function WorkflowHistorySection({ workflowId }: Props) {
  const { data, isLoading } = useWorkflowHistory(workflowId);
  const [expanded, setExpanded] = React.useState(false);
  const [viewEntry, setViewEntry] = React.useState<WorkflowVersionHistoryEntry | null>(null);
  const [restoreEntry, setRestoreEntry] = React.useState<WorkflowVersionHistoryEntry | null>(null);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  const history = data?.history ?? [];
  const currentHash = data?.currentWorkflowHash;

  if (history.length === 0) {
    return <div className="text-sm text-neutral-500">No version history yet.</div>;
  }

  const visible = expanded ? history : history.slice(0, INITIAL_VISIBLE);
  const hiddenCount = history.length - visible.length;

  return (
    <>
      <div className="flex flex-col gap-1.5">
        {visible.map((entry) => {
          const isCurrent = entry.workflowHash === currentHash;
          const label = entry.version ? `v${entry.version}` : shortHash(entry.workflowHash);
          const variant = SOURCE_VARIANT[entry.source];
          return (
            <div
              key={entry.id}
              className="flex flex-col gap-1 px-3 py-2 rounded-lg border border-border bg-surface-1"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm text-foreground">{label}</span>
                {isCurrent && <Badge variant="success">Current</Badge>}
                <Badge variant={variant}>{SOURCE_LABEL[entry.source]}</Badge>
                <span className="text-xs text-neutral-500 ml-auto">
                  {formatRelativeTime(entry.createdAt)}
                </span>
              </div>

              {entry.notes && (
                <div className="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">
                  {entry.notes}
                </div>
              )}

              <div className="flex items-center gap-1 mt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setViewEntry(entry)}
                >
                  View
                </Button>
                {!isCurrent && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setRestoreEntry(entry)}
                  >
                    Restore
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-xs text-neutral-500 hover:text-foreground mt-1 self-start"
          >
            Show {hiddenCount} more
          </button>
        )}
        {expanded && history.length > INITIAL_VISIBLE && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-xs text-neutral-500 hover:text-foreground mt-1 self-start"
          >
            Show less
          </button>
        )}
      </div>

      {viewEntry && (
        <VersionViewDialog entry={viewEntry} onClose={() => setViewEntry(null)} />
      )}
      {restoreEntry && (
        <RestoreVersionDialog
          workflowId={workflowId}
          entry={restoreEntry}
          onClose={() => setRestoreEntry(null)}
        />
      )}
    </>
  );
}
