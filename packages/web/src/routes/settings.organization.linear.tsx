import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useConnectLinear, useDisconnectLinear, useLinearConnection, useSaveLinearApp } from "~/api/linear";
import { apiErrorMessage } from "~/api/policies";
import { Badge, Button, ConfirmDialog, ErrorRow, Input, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";

export const Route = createFileRoute("/settings/organization/linear")({ component: OrganizationLinearPage });

export function OrganizationLinearPage() {
  const status = useLinearConnection();
  const connect = useConnectLinear();
  const disconnect = useDisconnectLinear();
  const [confirm, setConfirm] = useState(false);
  const save = useSaveLinearApp();
  const [clientId, setClientId] = useState<string>();
  const [clientSecret, setClientSecret] = useState("");
  const [editing, setEditing] = useState(false);
  const data = status.data;
  return <Section title="Linear events" description="Receive Linear events to start workflows. Personal Linear connections provide tool access only.">
    {status.isPending ? <LoadingRow label="Loading Linear connection…" />
      : status.isError || !data ? <ErrorRow>Could not load Linear setup. <button className="underline" onClick={() => void status.refetch()}>Retry</button></ErrorRow>
      : <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span>{data.workspaceName ?? "Linear workspace"}</span>
          <Badge variant={data.ready ? "success" : "neutral"}>{data.ready ? "Events connected" : "Events not connected"}</Badge>
        </div>
        <div className="space-y-3 rounded border p-4">
          <h3 className="font-medium">Linear application</h3>
          <p className="text-sm text-muted">{data.appSource === "organization" ? "Using your organization's application." : data.configured ? "Using the deployment's default application." : "Configure an application, then connect your Linear workspace."}</p>
          {data.redirectUri && <label className="block space-y-1 text-sm">Redirect URI<Input readOnly value={data.redirectUri} onFocus={event => event.target.select()} /></label>}
          {(!data.configured || editing) && !data.connected ? <form className="space-y-3" onSubmit={event => {
            event.preventDefault();
            save.mutate({ clientId: (clientId ?? data.clientId ?? "").trim(), clientSecret: clientSecret.trim() }, {
              onSuccess: () => { setClientSecret(""); setEditing(false); },
            });
          }}>
            <p className="text-sm text-muted">Create an application in Linear developer settings with the redirect URI above. Valet configures the event webhook when you connect.</p>
            <label className="block space-y-1 text-sm">Client ID<Input required autoComplete="off" value={clientId ?? data.clientId ?? ""} onChange={event => setClientId(event.target.value)} /></label>
            <label className="block space-y-1 text-sm">Client secret<Input required type="password" autoComplete="new-password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} /></label>
            <p className="text-sm text-muted">Credentials are encrypted and stored for this organization. The secret is never displayed again.</p>
            <Button type="submit" disabled={save.isPending || !(clientId ?? data.clientId ?? "").trim() || !clientSecret.trim()}>{save.isPending ? "Saving…" : "Save application"}</Button>
            {save.error && <ErrorRow>{apiErrorMessage(save.error)}</ErrorRow>}
          </form> : data.connected ? <p className="text-sm text-muted">Disconnect events before changing the application.</p> : <Button variant="secondary" onClick={() => setEditing(true)}>Configure application</Button>}
        </div>
        <div className="flex gap-2">
          <Button disabled={!data.configured || connect.isPending || disconnect.isPending || save.isPending} onClick={() => connect.mutate()}>
            {connect.isPending ? "Connecting…" : data.connected ? "Reconnect events" : "Connect events"}
          </Button>
          {data.connected && <Button variant="secondary" disabled={disconnect.isPending || connect.isPending} onClick={() => { disconnect.reset(); setConfirm(true); }}>Disconnect</Button>}
        </div>
        {connect.error && <ErrorRow>{apiErrorMessage(connect.error)} Retry connecting.</ErrorRow>}
      </div>}
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Disconnect Linear events?"
      description="Linear events will stop starting workflows. Personal tool connections remain available."
      confirmLabel="Disconnect" pendingLabel="Disconnecting…" pending={disconnect.isPending}
      error={disconnect.error ? apiErrorMessage(disconnect.error) : undefined}
      onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => setConfirm(false) })} />
  </Section>;
}
