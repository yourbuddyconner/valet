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
import type { WorkflowVersionHistoryEntry } from '@/api/workflows';

interface Props {
  entry: WorkflowVersionHistoryEntry;
  onClose: () => void;
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

export function VersionViewDialog({ entry, onClose }: Props) {
  const [copied, setCopied] = React.useState(false);

  // Pretty-print the snapshot. workflowData is the full WorkflowData object captured at this version.
  const pretty = React.useMemo(
    () => JSON.stringify(entry.workflowData, null, 2),
    [entry.workflowData]
  );

  const label = entry.version ? `v${entry.version}` : shortHash(entry.workflowHash);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(pretty);
      setCopied(true);
      // Reset the copied state after a short delay so users can copy again
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail in non-secure contexts; silently ignore so the dialog stays usable.
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Version {label}</DialogTitle>
          <DialogDescription>
            Snapshot of the workflow definition at this version.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex-1 min-h-0 overflow-auto rounded-md border border-border bg-surface-2">
          <pre className="p-3 text-xs font-mono text-foreground whitespace-pre">
            {pretty}
          </pre>
        </div>

        <div className="mt-3 text-xs text-neutral-500 font-mono">
          hash: {entry.workflowHash}
        </div>

        <DialogFooter className="mt-4">
          <Button type="button" variant="secondary" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
          <Button type="button" variant="primary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
