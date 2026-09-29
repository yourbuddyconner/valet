import { useState } from "react";
import { useTeamOnePasswordStatus, useTeamOnePasswordToken } from "~/api/onepassword";
import { Button, ConfirmDialog, ErrorRow, Input, LoadingRow } from "~/components/primitives";

/** Mounted with the team ID as key so drafts cannot move between teams. */
export function TeamOnePasswordToken({ teamId, teamName, canMutate }: {
  teamId: string; teamName: string; canMutate: boolean;
}) {
  const status = useTeamOnePasswordStatus(teamId);
  const mutation = useTeamOnePasswordToken(teamId);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [failed, setFailed] = useState(false);
  function submit(token: string | null) {
    setDraft("");
    setFailed(false);
    mutation.mutate(token, {
      onSuccess: () => setConfirm(false),
      onError: () => setFailed(true),
      onSettled: () => mutation.reset(),
    });
  }
  return <section aria-label={`1Password for ${teamName}`}>
    <h4 className="text-xs font-medium uppercase tracking-wide text-muted">1Password service account</h4>
    {status.isPending ? <LoadingRow label="Loading 1Password connection…" /> : status.isError ?
      <ErrorRow>Could not load the connection. <Button onClick={() => void status.refetch()}>Retry</Button></ErrorRow> :
      <p className="mt-1 text-xs text-muted">{status.data.tokenConnected
        ? "Team token connected."
        : "No team token connected. Team runtimes use the organization token when available."}</p>}
    <p className="mt-1 text-xs text-muted">Valet finds credentials in the vaults this service account can access.</p>
    {canMutate && <div className="mt-2 flex items-center gap-2">
      <Input type="password" autoComplete="new-password" value={draft}
        aria-label={`1Password service account token for ${teamName}`}
        disabled={mutation.isPending || !status.isSuccess}
        onChange={(event) => setDraft(event.target.value)} />
      <Button disabled={!draft.trim() || mutation.isPending || !status.isSuccess} onClick={() => submit(draft.trim())}>
        {status.data?.tokenConnected ? "Replace token" : "Connect token"}
      </Button>
      <Button variant="ghost" disabled={!status.data?.tokenConnected || mutation.isPending || !status.isSuccess}
        onClick={() => { setFailed(false); setConfirm(true); }}>Disconnect</Button>
    </div>}
    {failed && !confirm && <ErrorRow>Could not save the connection. Check your team access and try again.</ErrorRow>}
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Disconnect 1Password from ${teamName}?`}
      description="Explicit team references will stop resolving. Automatic discovery can use the organization token again."
      confirmLabel="Disconnect" pendingLabel="Disconnecting…" pending={mutation.isPending}
      error={failed ? "Could not disconnect. Check your team access and try again." : undefined}
      onConfirm={() => submit(null)} />
  </section>;
}
