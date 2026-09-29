import type { WorkflowDefinition } from "@valet/workflow";
import { AssistantPanel } from "~/components/session/assistant-panel";
import { prefillComposerDraft } from "~/stores/composer-drafts";
import type { WorkflowAssistant } from "~/hooks/use-workflow-assistant";
import { workflowSuggestions } from "./assistant-suggestions";

export function WorkflowAssistantPanel({
  assistant,
  definition,
  workflowId,
}: {
  assistant: WorkflowAssistant;
  /**
   * The definition as the SERVER holds it, not the editor's draft. The
   * openings below are instructions for `patch_workflow`, which reads and
   * writes the stored workflow — an opening built from edits that are not
   * saved would name steps the agent cannot see.
   */
  definition: WorkflowDefinition;
  workflowId: string;
}) {
  const suggestions = workflowSuggestions(definition, workflowId);

  return (
    <aside
      aria-label="Workflow assistant"
      className="flex h-full min-h-0 flex-1 flex-col"
      data-testid="workflow-assistant"
    >
      <AssistantPanel title="Valet · Workflow" sessionId={assistant.sessionId} threadId={assistant.threadId} error={assistant.error} onRetry={assistant.retry}>
      <div className="shrink-0 border-b border-line px-4 py-3">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <span className="min-w-0">
            Changes save automatically. Undo them in Version history.
          </span>
        </p>
        {/* Openings drawn from this workflow, not a generic "ask me
            anything". They fill the composer rather than send, because
            several of them stop mid-sentence on purpose — the channel or
            the condition is the part only the user knows. They stay
            through the conversation: `workflowSuggestions` leads with
            steps that are broken, so the list is also a repair list after
            the agent adds a step and leaves it unwired. */}
        {suggestions.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <li key={suggestion.label}>
                <button
                  type="button"
                  disabled={!assistant.sessionId || !assistant.threadId}
                  onClick={() => { if (assistant.sessionId && assistant.threadId) prefillComposerDraft(assistant.sessionId, assistant.threadId, suggestion.prompt); }}
                  className="min-h-11 rounded-full border border-line sm:min-h-0 px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-moss hover:bg-moss-wash focus:outline-none focus-visible:ring-2 focus-visible:ring-moss"
                >
                  {suggestion.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      </AssistantPanel>
    </aside>
  );
}
