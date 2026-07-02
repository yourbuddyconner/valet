import { useEffect, useState } from 'react';
import type { WorkflowPublishedVersion } from '@/api/workflows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  buildWorkflowVersionRows,
  type WorkflowVersionRow,
} from './workflow-detail-view-model';

interface WorkflowVersionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowName: string;
  versions: WorkflowPublishedVersion[];
  publishedVersionId: string | null | undefined;
  isLoading: boolean;
  isRestoring: boolean;
  onRestore: (version: WorkflowPublishedVersion) => void;
}

const versionDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function WorkflowVersionsDialog({
  open,
  onOpenChange,
  workflowName,
  versions,
  publishedVersionId,
  isLoading,
  isRestoring,
  onRestore,
}: WorkflowVersionsDialogProps) {
  const [confirmingVersionId, setConfirmingVersionId] = useState<string | null>(null);
  const versionRows = buildWorkflowVersionRows(versions, publishedVersionId);

  useEffect(() => {
    if (!open) {
      setConfirmingVersionId(null);
    }
  }, [open]);

  function handleRestoreClick(version: WorkflowVersionRow) {
    if (version.isActive || isRestoring) return;
    if (confirmingVersionId !== version.id) {
      setConfirmingVersionId(version.id);
      return;
    }
    onRestore(version);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0">
        <DialogHeader className="border-b border-neutral-200 px-6 py-5 dark:border-neutral-800">
          <DialogTitle>Workflow versions</DialogTitle>
          <DialogDescription>
            Restore a published version of {workflowName} to the editable draft. Triggers keep
            using the active published version until you publish again.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[64vh] overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              Loading versions...
            </div>
          ) : versionRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-200 p-6 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              No published versions yet.
            </div>
          ) : (
            <div className="space-y-3">
              {versionRows.map((version) => {
                const isConfirming = confirmingVersionId === version.id;
                return (
                  <div
                    key={version.id}
                    className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-neutral-950 dark:text-neutral-100">
                            Version {version.version}
                          </h3>
                          {version.isActive && <Badge variant="success">Active</Badge>}
                          <Badge variant="secondary">{version.hashLabel}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                          Published {versionDateFormatter.format(new Date(version.createdAt))}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant={isConfirming ? 'primary' : 'secondary'}
                        size="sm"
                        disabled={version.isActive || isRestoring}
                        onClick={() => handleRestoreClick(version)}
                        className={
                          isConfirming
                            ? 'bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-500 dark:hover:bg-amber-400'
                            : undefined
                        }
                      >
                        {version.isActive
                          ? 'Current'
                          : isRestoring && isConfirming
                            ? 'Restoring...'
                            : isConfirming
                              ? 'Confirm restore'
                              : 'Restore to draft'}
                      </Button>
                    </div>

                    <div className="mt-3 rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
                      {version.publishNote ? version.publishNote : 'No publish note.'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
