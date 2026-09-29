import type { AgentStatus, ConnectionStatus } from "~/stores/stream";
import { Tooltip } from "~/components/primitives";
import { cn } from "~/lib/cn";

/** Activity is not PR state: ready does not mean a pull request was merged. */
export function ThreadStatusIcon({ status, busy = false, needsApproval = false, conn }: {
  status: AgentStatus;
  busy?: boolean;
  needsApproval?: boolean;
  conn?: ConnectionStatus;
}) {
  const disconnected = conn !== undefined && conn !== "open";
  const waiting = needsApproval || status === "blocked_on_decision_gate";
  const working = busy || (status !== "idle" && status !== "error");
  const label = waiting ? "Needs approval" : status === "error" ? "Thread failed" : disconnected ? "Thread status unavailable — reconnecting" : working ? "Working" : "Ready";
  if (!waiting && status === "idle" && !busy && !disconnected) return null;
  return (
    <Tooltip content={label}>
      <span role="img" aria-label={label} className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
        <span className={cn("h-2 w-2 rounded-full", waiting ? "bg-amber-500" : status === "error" ? "bg-danger-500" : disconnected ? "border border-muted" : working ? "bg-blue-500 animate-pulse motion-reduce:animate-none" : "bg-neutral-400")} />
      </span>
    </Tooltip>
  );
}
