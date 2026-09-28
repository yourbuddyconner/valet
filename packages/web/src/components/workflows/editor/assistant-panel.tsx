/**
 * The workflow editor's right-hand column: the assistant conversation.
 *
 * The column used to hold a card that summarised the definition and
 * offered a button to open the assistant as a second panel beside it. The
 * summary restated the canvas, and the button put the primary way to
 * change a workflow one click behind something that could change nothing.
 * The column IS the conversation now. The per-node forms take the same
 * column while a step is selected (`editor.tsx`), because they edit one
 * step by hand rather than describe a change to the whole workflow.
 *
 * It is a host for the shared `SessionView`, not a second chat: the
 * transcript, the tool cards, slash commands, steering, abort, and the
 * decision-gate card all come from the one implementation `/chat`, the
 * standalone session page, and the child slide-over already use. Assistant
 * sessions run headless, so `SandboxTabs` renders nothing here and the
 * panel is header, transcript, gate, composer.
 *
 * The panel does not apply the edits it causes. `workflows.patch_workflow`
 * writes straight to the stored definition; `useWorkflowPatchWatch` (owned
 * by the editor page) refetches, and the editor adopts.
 */
import { Sparkles } from "lucide-react";
import type { WorkflowDefinition } from "@valet/workflow";
import { SessionView } from "~/components/session/session-view";
import { Button, Spinner } from "~/components/primitives";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
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
      <div className="border-b border-line px-3 py-2">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-moss" aria-hidden />
          <span className="min-w-0">
            Edits here are saved as they are made. To undo one, use Version history.
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
                  onClick={() => useComposerPrefillStore.getState().set(suggestion.prompt)}
                  className="min-h-11 rounded-full border border-line sm:min-h-0 px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-moss hover:bg-moss-wash focus:outline-none focus-visible:ring-2 focus-visible:ring-moss"
                >
                  {suggestion.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {assistant.error !== undefined ? (
        // Recovery repeats the server request without a page reload.
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-danger-500">{assistant.error}</p>
          <Button size="sm" variant="secondary" onClick={assistant.retry}>
            Retry
          </Button>
        </div>
      ) : assistant.sessionId === undefined || assistant.threadId === undefined ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
          {/* Names the outstanding step. One spinner for both calls gave no
              clue which one was slow when the panel hung. */}
          <Spinner size={14} />
          {assistant.stage === "session" ? "Opening your assistant…" : "Starting the conversation…"}
        </div>
      ) : (
        <SessionView panel sessionId={assistant.sessionId} activeThreadId={assistant.threadId} />
      )}
    </aside>
  );
}
