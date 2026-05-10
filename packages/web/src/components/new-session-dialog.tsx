import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "~/components/primitives";
import { useCreateSession } from "~/api/queries";

const DEFAULT_WORKSPACE = "/tmp/valet/workspace";

export function NewSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateSession();
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);

  async function submit() {
    const ws = workspace.trim();
    if (!ws) return;
    try {
      const created = await create.mutateAsync({ workspace: ws });
      onOpenChange(false);
      navigate({ to: "/sessions/$sessionId", params: { sessionId: created.id } });
    } catch {
      // useMutation surfaces the error in `create.error`; the dialog stays open.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New session"
        description="The agent runs bash, read, write, and edit tools against this workspace inside a Docker sandbox."
      >
        <div className="grid gap-1">
          <Label htmlFor="workspace">Workspace path</Label>
          <Input
            id="workspace"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder={DEFAULT_WORKSPACE}
            autoFocus
          />
          <p className="text-xs text-[--muted]">
            Absolute path on this host. Will be created if missing.
          </p>
        </div>

        {create.error && (
          <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
            {create.error.message}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || !workspace.trim()}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
