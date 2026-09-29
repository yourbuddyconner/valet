import type { RuntimeGrantWire } from "@valet/api/wire";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, ConfirmDialog } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { apiErrorMessage, useDeleteMyGrant, useMyGrants } from "~/api/policies";

/**
 * `/settings/policies` — "My active grants" (action-policies plan, Task 5).
 * Runtime grants scoped to a session or workflow execution (never both —
 * see `RuntimeGrantWire`); revoke is a soft-revoke keyed by scope +
 * `policyKey` (`service:actionId`), not by grant id, matching
 * `DeleteGrantRequest`'s target-addressing.
 */
export function GrantsSection() {
  const grantsQ = useMyGrants();
  const del = useDeleteMyGrant();
  if (grantsQ.error) return <p role="alert">{apiErrorMessage(grantsQ.error)}</p>;
  if (!grantsQ.data) return <p role="status">Loading…</p>;
  return <GrantsList grants={grantsQ.data.grants} title="My active grants" canEdit pending={del.isPending}
    revoke={g => {
      const [service, actionId] = splitPolicyKey(g.policyKey);
      return del.mutateAsync({ sessionId: g.sessionId ?? undefined, workflowExecutionId: g.workflowExecutionId ?? undefined, service, actionId });
    }} />;
}

export function GrantsList({ grants, title, canEdit, pending, revoke }: {
  grants: RuntimeGrantWire[]; title: string; canEdit: boolean; pending: boolean;
  revoke: (grant: RuntimeGrantWire) => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<RuntimeGrantWire | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  return (
    <Section title={title} description="Runtime grants for the current runtime or workflow run.">
      {grants.length === 0 && (
        <p className="py-4 text-sm text-muted">No active grants.</p>
      )}
      {grants.map((g) => {
        return (
          <div key={g.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1 break-all">
              <span className="text-sm font-medium text-[--fg]">{g.policyKey}</span>
              <p className="text-xs text-muted">
                {g.sessionId ? `runtime ${g.sessionId}` : `workflow run ${g.workflowExecutionId}`}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Revoke grant ${g.policyKey}`}
              disabled={!canEdit || pending}
              onClick={() => {
                setRowError(null);
                if (canEdit) setSelected(g);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
      <ConfirmDialog open={selected !== null && canEdit} onOpenChange={open => { if (!open) setSelected(null); }}
        title="Revoke grant?" description="This runtime or run will need approval again when policy requires it." confirmLabel="Revoke grant"
        pending={pending} error={rowError} onConfirm={() => {
          if (selected && canEdit) void revoke(selected).then(() => setSelected(null), err => setRowError(apiErrorMessage(err)));
        }} />
      {rowError && <p className="pb-2 text-xs text-danger-500">{rowError}</p>}
    </Section>
  );
}

/** `policyKey` is `${service}.${actionId}` (see `grantPolicyKey` in
 *  `policies/resolution.ts`) — `actionId` itself may contain further dots
 *  (e.g. `gmail.send_email`), so split on the FIRST dot only, never the
 *  service name. */
function splitPolicyKey(policyKey: string): [string, string] {
  const idx = policyKey.indexOf(".");
  if (idx === -1) return [policyKey, ""];
  return [policyKey.slice(0, idx), policyKey.slice(idx + 1)];
}
