import { Link } from "@tanstack/react-router";
import type { TeamSummary } from "@valet/api/wire";
import { useWorkspaceConversation } from "~/hooks/use-workspace-conversation";
import { ThreadTree, ThreadTreeWaiting } from "./thread-tree";

/** Workspace thread list. Assistant profiles are internal routing identities. */
export function AssistantRail() {
  const conversation = useWorkspaceConversation();
  if (conversation.error) return <div role="alert" className="p-4 text-sm text-danger-500">
    Could not load threads. <button className="underline" onClick={() => void conversation.refetch()}>Retry</button>
  </div>;
  return <>
    <Link to="/chat" search={prev => ({ workspace: prev.workspace, view: "work" })} className="border-b border-line px-4 py-3 text-sm hover:bg-ink-wash">Work and artifacts</Link>
    {conversation.data ? <ThreadTree sessionId={conversation.data.sessionId} /> : <ThreadTreeWaiting />}
  </>;
}

/** Teams whose assistants the caller may open: the org feature gate is on,
 * and they are a member. An org admin sees every team in the org from
 * `GET /api/teams`, so membership alone is not the test — `callerRole` is
 * null for a team they only administer. */
export function eligibleTeams(
  teams: TeamSummary[] | undefined,
  organizationsEnabled: boolean | undefined,
): TeamSummary[] {
  if (organizationsEnabled !== true) return [];
  return (teams ?? []).filter((t) => t.callerRole !== null);
}
