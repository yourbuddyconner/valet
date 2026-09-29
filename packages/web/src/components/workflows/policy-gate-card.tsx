/**
 * Pending policy-gate card for `/workflows/runs/$runId`.
 * Rendered for each `WorkflowPendingGate` with `kind === "policy_gate"`.
 *
 * Split-button: "Approve once" (primary) + chevron trigger opening a
 * DropdownMenu with "Approve for rest of run". Durable permission applies
 * only to this workflow. Deny is a separate danger button. Note field rides whichever action
 * fires. On 409 the query key is invalidated so the stale card disappears.
 */
import { type ReactElement, useState } from "react";
import { ChevronDown, ShieldAlert } from "lucide-react";
import type { WorkflowPendingGate } from "@valet/api/wire";
import { useResolveApproval } from "~/api/workflows";
import { ApiError } from "~/api/client";
import { apiErrorMessage } from "~/api/policies";
import {
  Button,
  ConfirmDialog,
  Spinner,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/components/primitives";
import { RiskBadge } from "./risk-badge";
import { cn } from "~/lib/cn";

export interface PolicyGateCardProps {
  runId: string;
  gate: WorkflowPendingGate; // kind === "policy_gate"
  confirmActions?: boolean;
}

export function PolicyGateCard({ runId, gate, confirmActions = false }: PolicyGateCardProps): ReactElement {
  const [note, setNote] = useState("");
  const [busyScope, setBusyScope] = useState<"once" | "run" | "workflow" | "deny" | null>(null);
  const [confirmation, setConfirmation] = useState<"once" | "run" | "workflow" | "deny" | null>(null);
  const resolve = useResolveApproval(runId);

  const service = gate.service ?? "";
  const action = gate.action ?? "";
  const serviceAction = service && action ? `${service}.${action}` : gate.nodeId;

  const busy = resolve.isPending;

  function fireApprove(scope: "once" | "run" | "workflow") {
    if (confirmActions || scope === "workflow") {
      setConfirmation(scope);
      return;
    }
    submitApprove(scope);
  }

  function submitApprove(scope: "once" | "run" | "workflow") {
    setBusyScope(scope);
    resolve.mutate({
      nodeId: gate.nodeId,
      body: {
        approved: true,
        scope,
        note: note.trim() || undefined,
        iteration: gate.iteration,
      },
    });
    setConfirmation(null);
  }

  function handleDeny() {
    if (confirmActions) {
      setConfirmation("deny");
      return;
    }
    submitDeny();
  }

  function submitDeny() {
    setBusyScope("deny");
    resolve.mutate({
      nodeId: gate.nodeId,
      body: {
        approved: false,
        scope: "once",
        note: note.trim() || undefined,
        iteration: gate.iteration,
      },
    });
    setConfirmation(null);
  }

  // `ApiError.message` is "{method} {path} → {status}" — the server's {error}
  // body is in `error.payload`. Detect 409-already-resolved by status code, not
  // message text; extract the human-readable server message via `apiErrorMessage`.
  const is409AlreadyResolved =
    resolve.isError &&
    resolve.error instanceof ApiError &&
    resolve.error.status === 409;
  const errorMsg = resolve.isError && resolve.error
    ? is409AlreadyResolved
      ? null // shown as the special already-resolved banner below
      : apiErrorMessage(resolve.error)
    : null;

  const denyMicrocopy =
    gate.onDeny === "skip"
      ? "Denying skips this node; downstream nodes can branch on the denial."
      : "Denying fails this node.";

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50/70 dark:border-amber-700/60 dark:bg-amber-950/40 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-200 dark:bg-amber-900/60">
          <ShieldAlert className="h-3.5 w-3.5 text-amber-800 dark:text-amber-300" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
            Policy gate
            {gate.iteration != null ? ` • Iteration ${gate.iteration}` : ""}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all font-mono text-sm font-semibold text-ink">{serviceAction}</code>
            {gate.riskLevel && <RiskBadge level={gate.riskLevel} />}
          </div>
        </div>
      </div>

      {/* Provenance */}
      {gate.provenance === "resolver_error" && (
        <div className="text-xs text-amber-800 dark:text-amber-300">
          Policy check failed — approval requested as a safe fallback.
        </div>
      )}

      {/* Params */}
      {gate.gateParams != null && (
        <details className="text-xs text-muted">
          <summary className="min-h-11 cursor-pointer select-none py-3 font-medium sm:min-h-0 sm:py-0 text-ink">
            Parameters
          </summary>
          <pre className="mt-1.5 overflow-x-auto rounded bg-[--bg] p-2 font-mono text-xs text-muted">
            {JSON.stringify(gate.gateParams, null, 2)}
          </pre>
          {gate.gateParamsTruncated && (
            <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              Parameters truncated — only a portion is shown.
            </div>
          )}
        </details>
      )}

      {/* Note input */}
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note"
        disabled={busy}
        className={cn(
          "min-h-11 w-full rounded border border-line bg-[--bg] px-2 py-1.5 sm:min-h-0 text-sm text-ink",
          "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss",
          "disabled:opacity-50",
        )}
      />

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => fireApprove("workflow")} disabled={busy}>Allow for this workflow</Button>
        {/* Split-button: Approve once + dropdown */}
        <div className="flex items-center">
          <Button
            size="sm"
            className="rounded-r-none"
            onClick={() => fireApprove("once")}
            disabled={busy}
          >
            {busy && busyScope === "once" ? <Spinner size={12} /> : null}
            Approve once
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="rounded-l-none border-l border-white/25 px-1.5"
                disabled={busy}
                aria-label="More approval options"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() => fireApprove("run")}
                disabled={busy}
              >
                <div>
                  <div>Approve for rest of run</div>
                  <div className="text-xs text-muted">
                    Covers every later call to {serviceAction} in this run.
                  </div>
                </div>
              </DropdownMenuItem>

            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Deny */}
        <Button size="sm" variant="danger" onClick={handleDeny} disabled={busy}>
          {busy && busyScope === "deny" ? <Spinner size={12} /> : null}
          Deny
        </Button>
      </div>

      {/* Deny microcopy */}
      <div className="text-[11px] text-muted">{denyMicrocopy}</div>

      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title={confirmation === "deny" ? "Deny this tool action?" : "Allow this tool action?"}
        description={
          confirmation === "workflow"
            ? `Allow ${serviceAction} for future runs of this workflow only, until its saved permissions are reset. Existing policy restrictions remain in effect.`
            : confirmation === "run"
            ? `Valet runs ${serviceAction} now and allows later calls in this run.`
            : confirmation === "deny"
              ? denyMicrocopy
              : `Valet runs ${serviceAction} once with the shown parameters.`
        }
        confirmLabel={confirmation === "deny" ? "Deny action" : "Allow action"}
        onConfirm={() => {
          if (confirmation === "deny") submitDeny();
          else if (confirmation !== null) submitApprove(confirmation);
        }}
      />

      {/* Footer: timeout + error */}
      {(gate.timeoutAt != null || is409AlreadyResolved || errorMsg != null) && (
        <div className="space-y-1">
          {gate.timeoutAt != null && (
            <div className="text-[11px] text-muted">
              Gate times out {new Date(gate.timeoutAt).toLocaleString()}.
            </div>
          )}
          {is409AlreadyResolved && (
            <div className="text-xs text-muted">
              This gate was already resolved. Refreshing…
            </div>
          )}
          {errorMsg != null && (
            <div className="text-xs text-danger-500">
              {errorMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
