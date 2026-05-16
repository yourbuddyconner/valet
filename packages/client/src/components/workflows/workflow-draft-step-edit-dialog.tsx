import { useState } from 'react';
import type { WorkflowData, WorkflowStep } from '@/api/workflows';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

interface Props {
  workflow: WorkflowData;
  stepId: string;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
  loading: boolean;
}

export function WorkflowDraftStepEditDialog({
  workflow,
  stepId,
  onSubmit,
  onClose,
  loading,
}: Props) {
  const [text, setText] = useState('');
  const step = findStep(workflow.steps, stepId);
  if (!step) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit step: {step.name ?? step.id}</DialogTitle>
        </DialogHeader>
        <pre className="text-xs bg-neutral-50 border border-neutral-200 rounded p-2 mt-2 mb-3 max-h-40 overflow-y-auto">
          {JSON.stringify(step, null, 2)}
        </pre>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='Change this step to… (e.g. "use bash instead of an agent message")'
          className="w-full min-h-[80px] rounded-md border border-neutral-300 px-3 py-2 text-sm"
          autoFocus
        />
        <DialogFooter className="mt-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-neutral-300 rounded-md"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(text)}
            disabled={loading || !text.trim()}
            className="px-3 py-1.5 text-sm bg-neutral-900 text-white rounded-md disabled:opacity-50"
          >
            {loading ? 'Updating…' : 'Update step'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function findStep(steps: WorkflowStep[], id: string): WorkflowStep | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    const inner = findStep(s.then ?? s.else ?? s.steps ?? [], id);
    if (inner) return inner;
  }
  return undefined;
}
