import type { ReactNode } from "react";

/** The same review vocabulary for assistant proposals and manual setup. */
export function AutomationReview({ when, scope, result, destination, permissions, workflowId, follow, audience }: {
  when: ReactNode;
  scope: ReactNode;
  result: ReactNode;
  destination: ReactNode;
  permissions?: ReactNode;
  workflowId?: string;
  follow?: boolean;
  audience?: string;
}) {
  const rows = [
    ["When", when], ["Scope", scope], ["Result", result], ["Destination", destination],
    ...(follow !== undefined ? [["Delivery", follow ? "Also deliver later replies from the source thread" : "Deliver only events matching these filters"]] : []),
    ...(audience ? [["Audience", audience === "team" ? "Team members" : "Anyone in the organization"]] : []),
    ["Permissions", permissions ?? (workflowId ? <span><a className="text-moss underline" href={`/workflows/${encodeURIComponent(workflowId)}`} target="_blank" rel="noreferrer">Review workflow permissions</a>. Enabling grants no new access. Dynamic actions are checked at runtime.</span> : "Uses this workspace’s existing access. Enabling does not grant new permissions.")],
  ];
  return <dl aria-label="Automation review" className="divide-y divide-line rounded-lg border border-line px-3">
    {rows.map(([label, value], index) => <div key={index} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 py-3 text-sm">
      <dt className="text-muted">{label}</dt><dd className="min-w-0 break-words">{value || "Not configured"}</dd>
    </div>)}
  </dl>;
}
