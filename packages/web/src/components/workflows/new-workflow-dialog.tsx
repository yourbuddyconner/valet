import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCreateWorkflow } from "~/api/workflows";
import { Button, Dialog, DialogContent, DialogFooter, Input, Label } from "~/components/primitives";
import { createDefaultWorkflowDefinition } from "./editor-model";
import { errorText } from "~/lib/error-text";
import { useWorkspaceScope } from "~/lib/workspace-scope";

const DEFAULT_NAME = "Untitled workflow";

export function NewWorkflowDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const scope = useWorkspaceScope();
  return <WorkflowCreationForm key={scope.teamId === undefined ? "personal" : `team:${scope.teamId}`}
    open={open} onOpenChange={onOpenChange} teamId={scope.teamId} />;
}

function WorkflowCreationForm({ open, onOpenChange, teamId }: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  teamId: string | undefined;
}) {
  const navigate = useNavigate();
  const create = useCreateWorkflow();
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [open]);
  const [name, setName] = useState(DEFAULT_NAME);

  async function submit() {
    const trimmed = name.trim();
    if (!open || create.isPending || !trimmed) return;
    const requestGeneration = generation.current;
    try {
      const created = await create.mutateAsync({
        name: trimmed,
        definition: createDefaultWorkflowDefinition(),
        ...(teamId === undefined ? {} : { teamId }),
      });
      // A workspace change unmounts this form. Its late response must not
      // close the new form or navigate away from the new workspace.
      if (generation.current !== requestGeneration) return;
      onOpenChange(false);
      setName(DEFAULT_NAME);
      void navigate({ to: "/workflows/$workflowId", params: { workflowId: created.id } });
    } catch {
      // useMutation surfaces the error in `create.error`; the dialog stays open.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        title="New workflow"
        description="Start with an empty workflow and add steps in the editor."
      >
        <div className="grid gap-1">
          <Label htmlFor="workflow-name">Name</Label>
          <Input
            id="workflow-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder={DEFAULT_NAME}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>

        {create.error && (
          <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
            {errorText(create.error)}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || !name.trim()}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
