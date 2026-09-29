import { Link } from "@tanstack/react-router";
import type { WorkflowActionRequiredItem } from "@valet/api/wire";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { OwnerBadge } from "~/components/owner-badge";
import { relativeTime } from "~/lib/relative-time";
import { ApprovalCard } from "./approval-card";
import { PolicyGateCard } from "./policy-gate-card";

export function WorkflowApprovalItem({
  item,
  focused = false,
}: {
  item: WorkflowActionRequiredItem;
  focused?: boolean;
}) {
  const { gate } = item;
  const policy = gate.kind === "policy_gate";
  const action = policy && gate.service && gate.action ? `${gate.service}.${gate.action}` : gate.nodeId;
  const reason = policy
    ? gate.provenance === "resolver_error"
      ? "The policy check failed. Valet paused the action for a safe decision."
      : "Your tool policy requires permission before Valet can run this action."
    : (gate.prompt ?? "This workflow includes a human approval step.");
  return (
    <li
      data-testid="action-required-item"
      className={`min-w-0 rounded-lg border bg-paper p-3 sm:p-4 ${focused ? "border-warning-fg ring-2 ring-warning-fg/20" : "border-line"}`}
    >
      <div className="mb-3 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-warning-wash px-2 py-0.5 text-xs font-medium text-warning-fg">
              <ShieldAlert className="h-3 w-3" aria-hidden />
              {policy ? "Tool permission" : "Workflow approval"}
            </span>
            {/* The run's OWN snapshot names this assistant, so re-pinning
                the workflow while the run waits does not move the badge
                beside a permission decision. Absent means the snapshot pins
                none, and the owner's default assistant runs it. */}
            <OwnerBadge
              ownerType={item.owner.type}
              ownerId={item.owner.id}
            />
          </div>
          <Link
            to="/workflows/$workflowId"
            params={{ workflowId: item.workflowId }}
            className="block break-words text-sm font-semibold text-ink hover:underline"
          >
            {item.workflowName}
          </Link>
          {policy && <p className="break-all font-mono text-xs text-muted">{action}</p>}
        </div>
        <div className="shrink-0 text-left text-xs text-muted sm:text-right">
          <div>Requested {relativeTime(gate.waitingSince ?? item.runCreatedAt)}</div>
          <div>
            {item.trigger.type === "manual" ? "Started manually" : `Started by ${item.trigger.type}`}
            {item.trigger.triggerId ? ` (${item.trigger.triggerId})` : ""}
          </div>
          <Link
            to="/workflows/runs/$runId"
            params={{ runId: item.runId }}
            className="inline-flex min-h-11 items-center underline sm:min-h-0"
          >
            Open run
          </Link>
        </div>
      </div>
      <details className="group" open={focused || undefined}>
        <summary className="cursor-pointer list-none text-sm text-muted [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <ChevronRight className="h-4 w-4 shrink-0 group-open:rotate-90" aria-hidden />
            <span className="shrink-0">Review request<span className="sr-only"> for {item.workflowName}</span></span>
            <span className="truncate text-xs">{policy ? action : gate.prompt}</span>
          </span>
        </summary>
        <div className="mt-3">
      {policy && <p className="mb-3 text-xs text-muted">{reason}</p>}
      {policy ? (
        <PolicyGateCard runId={item.runId} gate={gate} confirmActions />
      ) : (
        <ApprovalCard
          runId={item.runId}
          nodeId={gate.nodeId}
          prompt={gate.prompt}
          summary={gate.summary}
          details={gate.details}
          iteration={gate.iteration}
          confirmActions
        />
      )}
        </div>
      </details>
    </li>
  );
}
