import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qkArtifacts, useRevokeArtifact } from "~/api/artifacts";
import { ConfirmDialog } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

/** Render only when the reader response grants management to this caller. */
export function RevokeArtifact({ id, title, token, onRevoked }: {
  id: string;
  title: string;
  token: string;
  onRevoked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const revoke = useRevokeArtifact();
  const queryClient = useQueryClient();
  const error = revoke.error ? `Could not revoke this link. ${errorText(revoke.error)} Retry after you check your access.` : undefined;
  return <>
    <button
      type="button"
      disabled={revoke.isPending}
      onClick={() => { revoke.reset(); setOpen(true); }}
      className="min-h-11 text-xs text-danger-500 hover:underline disabled:opacity-50 sm:min-h-0"
    >{revoke.isPending ? "Revoking…" : "Revoke"}</button>
    {error && !open && <span role="alert" className="text-xs text-danger-500">{error}</span>}
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={`Revoke the link to ${title}?`}
      description="This link will stop working for everyone. Publish the artifact again to get a new link."
      confirmLabel="Revoke"
      pendingLabel="Revoking…"
      pending={revoke.isPending}
      error={error}
      onConfirm={() => revoke.mutate({ id }, {
        onSuccess: () => {
          setOpen(false);
          onRevoked();
          void queryClient.invalidateQueries({ queryKey: qkArtifacts.byToken(token) });
        },
      })}
    />
  </>;
}
