import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useConnectLinear, useDisconnectLinear, useLinearConnection } from "~/api/linear";
import { apiErrorMessage } from "~/api/policies";
import { Badge, Button, ConfirmDialog, ErrorRow, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";

export const Route = createFileRoute("/settings/organization/linear")({ component: OrganizationLinearPage });

export function OrganizationLinearPage() {
  const status = useLinearConnection();
  const connect = useConnectLinear();
  const disconnect = useDisconnectLinear();
  const [confirm, setConfirm] = useState(false);
  const data = status.data;
  return <Section title="Linear events" description="Receive Linear events to start workflows. Personal Linear connections provide tool access only.">
    {status.isPending ? <LoadingRow label="Loading Linear connection…" />
      : status.isError || !data ? <ErrorRow>Could not load Linear setup. <button className="underline" onClick={() => void status.refetch()}>Retry</button></ErrorRow>
      : <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span>{data.workspaceName ?? "Linear workspace"}</span>
          <Badge variant={data.ready ? "success" : "neutral"}>{data.ready ? "Events connected" : "Events not connected"}</Badge>
        </div>
        {!data.configured && <p className="text-sm text-muted">Ask the deployment administrator to configure Linear OAuth before connecting events.</p>}
        <div className="flex gap-2">
          <Button disabled={!data.configured || connect.isPending || disconnect.isPending} onClick={() => connect.mutate()}>
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
