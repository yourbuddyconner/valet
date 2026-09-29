import { Link } from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import { AutomationReview } from "~/components/events/automation-review";
import { resultText, structuredResult, type ToolRenderer, type ToolRendererProps } from "./types";
import { ToolBody } from "./tool-shell";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const ids = ["events.propose_subscription", "workflows.propose_trigger", "workflows.propose_schedule"];
function ProposalBody({ result }: ToolRendererProps) {
  const data = record(structuredResult(result));
  const proposal = record(data?.proposal) ?? record(record(data?.data)?.proposal);
  if (!proposal || typeof proposal.id !== "string" || !["subscription", "schedule"].includes(String(proposal.kind))) return <ToolBody>{resultText(result)}</ToolBody>;
  const config = record(proposal.config);
  const target = record(config?.target);
  const keys = Array.isArray(config?.eventKeys) ? config.eventKeys.filter((key): key is string => typeof key === "string") : [];
  const filters = Array.isArray(config?.filters) ? config.filters.flatMap(filter => {
    const row = record(filter);
    return row && typeof row.field === "string" ? [`${row.field} ${String(row.op ?? "eq")}: ${String(row.label ?? row.value)}`] : [];
  }) : [];
  const schedule = proposal.kind === "schedule";
  const workflowId = typeof config?.workflowId === "string" ? config.workflowId : typeof target?.workflowId === "string" ? target.workflowId : undefined;
  return <div className="space-y-3 p-3">
    <AutomationReview follow={typeof target?.follow === "boolean" ? target.follow : undefined} audience={typeof config?.audience === "string" ? config.audience : undefined} workflowId={workflowId} when={schedule ? `${String(config?.cron ?? "")} (${String(config?.timezone ?? "")})` : keys.join(", ")}
      scope={filters.join("; ") || "Selected workspace"}
      result={String(target?.userPromptTemplate ?? config?.prompt ?? (workflowId ? "Run workflow" : "Deliver matching events to the assistant"))}
      destination={workflowId ?? "Workspace assistant"} />
    <p className="text-xs text-muted">Open the saved configuration to review its current settings. This preview does not grant permissions.</p>
    {schedule ? <Link className="text-sm text-moss underline" to="/workflows" search={{ tab: "scheduled", review: proposal.id }}>Review automation</Link>
      : <Link className="text-sm text-moss underline" to="/events" search={{ tab: "subscriptions", review: proposal.id }}>Review automation</Link>}
  </div>;
}
export const automationProposalRenderer: ToolRenderer = {
  matches: (name, args) => ids.some(id => name === id.replace(".", "__") || (name === "call_tool" && record(args)?.tool_id === id)),
  category: "write", Icon: ClipboardCheck,
  formatTarget: () => "Automation proposal",
  Body: ProposalBody,
};
