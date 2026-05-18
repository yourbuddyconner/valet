import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useRollbackWorkflowVersion } from '@/api/workflows';
import type { WorkflowVersionHistoryEntry } from '@/api/workflows';

interface Props {
  workflowId: string;
  entry: WorkflowVersionHistoryEntry;
  onClose: () => void;
  onRestored?: () => void;
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

export function RestoreVersionDialog({ workflowId, entry, onClose, onRestored }: Props) {
  const [notes, setNotes] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const rollback = useRollbackWorkflowVersion();
  const loading = rollback.isPending;

  const label = entry.version ? `v${entry.version}` : shortHash(entry.workflowHash);

  const handleConfirm = () => {
    setError(null);
    rollback.mutate(
      {
        workflowId,
        data: {
          targetWorkflowHash: entry.workflowHash,
          // Drop empty strings so the server applies its own defaults rather than persisting "".
          version: entry.version ?? undefined,
          notes: notes.trim() ? notes.trim() : undefined,
        },
      },
      {
        onSuccess: () => {
          onRestored?.();
          onClose();
        },
        onError: (e: unknown) => {
          const message = e instanceof Error ? e.message : 'Failed to restore version.';
          setError(message);
        },
      }
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !loading) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Restore {label}</DialogTitle>
          <DialogDescription>
            This will create a new version restoring this snapshot. The current version remains in
            the history.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-2">
          <label
            htmlFor="rollback-notes"
            className="text-xs font-medium text-neutral-600 dark:text-neutral-400"
          >
            Reason for rollback (optional)
          </label>
          <textarea
            id="rollback-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="e.g. reverting bad approval gate change"
            className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm shadow-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            disabled={loading}
          />
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <DialogFooter className="mt-6">
          <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={handleConfirm} disabled={loading}>
            {loading ? 'Restoring…' : 'Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
