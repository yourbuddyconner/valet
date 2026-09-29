import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "~/api/client";
import { useCreateWorkflow } from "~/api/workflows";
import { Composer } from "~/components/session/composer";
import { useWorkspaceAssistant } from "~/components/layout/workspace-assistant";
import { Button } from "~/components/primitives";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { createDefaultWorkflowDefinition } from "./editor-model";

/** The normal Thread composer, handed to the existing editor after its first send. */
export function WorkflowCreation({ onBack, onBegin }: { onBack?: () => void; onBegin: () => void }) {
  const scope = useWorkspaceScope();
  const assistant = useWorkspaceAssistant();
  const navigate = useNavigate();
  const create = useCreateWorkflow();
  const workflowId = useRef<string | undefined>(undefined);
  const [draftId] = useState(() => `workflow-draft:${crypto.randomUUID()}`);
  const preparing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const conversation = useQuery({
    queryKey: ["workflow-creation-runtime", scope.key],
    queryFn: () => api.ensureWorkspaceRuntime(scope.key),
    staleTime: Infinity,
  });

  async function prepare(text: string) {
    onBegin();
    // Reuse the saved shell when sending fails; a retry must not create another workflow.
    if (!workflowId.current) {
        const result = await create.mutateAsync({
          name: "Untitled workflow",
          definition: createDefaultWorkflowDefinition(),
          ...(scope.teamId ? { teamId: scope.teamId } : {}),
        });
        workflowId.current = result.id;
    }
    if (!mounted.current) throw new Error("Workspace changed. Open the saved workflow to continue.");
    const target = await api.ensureWorkflowConversation(workflowId.current);
    if (!mounted.current) throw new Error("Workspace changed. Open the saved workflow to continue.");
    return { threadId: target.threadId, text: `${text}\n\nHelp me build workflow ${workflowId.current} in this workspace. It currently contains only start and stop nodes. Give it a concise name based on my request. Clarify missing inputs, then use patch_workflow to build its steps incrementally so I can review the canvas. Do not run it or enable schedules or event subscriptions unless I explicitly ask.` };
  }

  return <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
    {onBack && <div><Button variant="ghost" size="sm" onClick={onBack}>Back to workflows</Button></div>}
    {assistant.isOpen ? <p className="my-auto text-center text-sm text-muted">Continue with Valet in the sidebar.</p>
      : conversation.isError ? <div role="alert" className="m-auto text-sm">Could not open Valet. <Button onClick={() => void conversation.refetch()}>Retry</Button></div>
      : !conversation.data ? <p className="m-auto text-sm text-muted">Opening Valet…</p>
      : <><div className="m-auto px-6 py-12 text-center"><h2 className="text-2xl font-semibold tracking-tight">What would you like to automate?</h2><p className="mt-3 text-sm text-muted">Describe the outcome. Build and review the steps with Valet.</p><p className="mt-2 text-xs text-muted">Each workflow keeps its own conversation.</p></div>
        <Composer sessionId={conversation.data.sessionId} threadId={draftId} agentStatus="idle"
          submissionLock={preparing}
          beforeSend={prepare}
          onSent={() => { if (mounted.current && workflowId.current) void navigate({ to: "/workflows/$workflowId", params: { workflowId: workflowId.current } }); }}
        /></>}
  </div>;
}
