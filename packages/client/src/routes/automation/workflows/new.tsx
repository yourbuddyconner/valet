import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  useDraftWorkflow,
  useDraftWorkflowStep,
  useSyncWorkflow,
  useWorkflow,
  type WorkflowData,
} from '@/api/workflows';
import { useCreateTrigger, type TriggerConfig } from '@/api/triggers';
import { WorkflowDraftEditor } from '@/components/workflows/workflow-draft-editor';
import { WorkflowDraftTriggerForm } from '@/components/workflows/workflow-draft-trigger-form';
import { WorkflowDraftStepEditDialog } from '@/components/workflows/workflow-draft-step-edit-dialog';

export const Route = createFileRoute('/automation/workflows/new')({
  component: NewWorkflowPage,
  validateSearch: (search: Record<string, unknown>) => ({
    editId: typeof search.editId === 'string' ? search.editId : undefined,
  }),
});

interface TriggerDraft {
  kind: 'schedule' | 'webhook' | 'manual';
  config: Record<string, unknown>;
}

function NewWorkflowPage() {
  const nav = useNavigate();
  const { editId } = Route.useSearch();
  const existing = useWorkflow(editId ?? '');

  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState<WorkflowData | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<TriggerDraft | null>({ kind: 'manual', config: {} });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);

  const draftMut = useDraftWorkflow();
  const stepMut = useDraftWorkflowStep();
  const syncMut = useSyncWorkflow();
  const createTrigger = useCreateTrigger();

  // Hydrate the draft from an existing workflow when ?editId= is set.
  useEffect(() => {
    if (existing.data?.workflow && !draft) {
      setDraft(existing.data.workflow.data);
      setPrompt(`Workflow loaded for editing: ${existing.data.workflow.name}`);
    }
  }, [existing.data, draft]);

  const handleGenerate = (text: string) => {
    setPrompt(text);
    draftMut.mutate(
      { prompt: text, baseDraft: draft ?? undefined },
      { onSuccess: (data) => setDraft(data.workflow) },
    );
  };

  const handleStepEdit = async (stepId: string, instruction: string) => {
    if (!draft) return;
    setStepError(null);
    try {
      const result = await stepMut.mutateAsync({ workflow: draft, stepId, instruction });
      setDraft(result.workflow);
      setEditingStepId(null);
    } catch (err) {
      setStepError(err instanceof Error ? err.message : 'Failed to update step.');
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaveError(null);
    try {
      await syncMut.mutateAsync({
        id: draft.id,
        name: draft.name,
        description: draft.description,
        data: draft,
        version: draft.version ?? '1.0.0',
      });
      if (trigger && trigger.kind !== 'manual') {
        const config = buildTriggerConfig(trigger);
        await createTrigger.mutateAsync({
          workflowId: draft.id,
          name: `${draft.name} ${trigger.kind}`,
          enabled: true,
          config,
        });
      }
      nav({ to: '/automation/workflows/$workflowId', params: { workflowId: draft.id } });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save workflow.');
    }
  };

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 bg-white border-b border-neutral-200">
        <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / WORKFLOWS</div>
        <h1 className="text-xl font-semibold">{editId ? 'Edit workflow' : 'New workflow'}</h1>
        <p className="text-sm text-neutral-600 mt-1">
          Describe what you want it to do. The agent drafts a workflow; you can refine it before
          saving.
        </p>
      </header>

      {stepError && (
        <div className="px-6 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700 flex items-start justify-between gap-3">
          <span>{stepError}</span>
          <button
            onClick={() => setStepError(null)}
            className="text-red-700 hover:text-red-900 text-xs font-medium shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {!draft ? (
        <EmptyState onSubmit={handleGenerate} loading={draftMut.isPending} />
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <WorkflowDraftEditor
            prompt={prompt}
            onRegenerate={() => handleGenerate(prompt)}
            onEditPrompt={(p) => setPrompt(p)}
            workflow={draft}
            onJsonToggle={() => setShowJson((v) => !v)}
            jsonOpen={showJson}
            onNodeClick={(stepId) => setEditingStepId(stepId)}
            onRefine={handleGenerate}
            refining={draftMut.isPending}
          />
          <WorkflowDraftTriggerForm value={trigger} onChange={setTrigger} />
          {saveError && (
            <div className="px-6 py-2 bg-red-50 border-t border-red-200 text-sm text-red-700">
              {saveError}
            </div>
          )}
          <div className="px-6 py-3 bg-white border-t border-neutral-200 flex justify-end gap-2">
            <button
              onClick={() => nav({ to: '/automation/workflows' })}
              className="px-4 py-1.5 text-sm border border-neutral-300 rounded-md hover:bg-neutral-50"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={syncMut.isPending}
              className="px-4 py-1.5 text-sm bg-emerald-700 text-white rounded-md font-medium hover:bg-emerald-800 disabled:opacity-50"
            >
              {syncMut.isPending ? 'Saving…' : 'Save workflow'}
            </button>
          </div>
        </div>
      )}

      {editingStepId && draft && (
        <WorkflowDraftStepEditDialog
          workflow={draft}
          stepId={editingStepId}
          onSubmit={(instruction) => handleStepEdit(editingStepId, instruction)}
          onClose={() => setEditingStepId(null)}
          loading={stepMut.isPending}
        />
      )}
    </div>
  );
}

function buildTriggerConfig(trigger: TriggerDraft): TriggerConfig {
  if (trigger.kind === 'schedule') {
    const cron = typeof trigger.config.cron === 'string' ? trigger.config.cron : '0 9 * * *';
    const timezone =
      typeof trigger.config.timezone === 'string' ? trigger.config.timezone : undefined;
    const target =
      trigger.config.target === 'orchestrator' || trigger.config.target === 'workflow'
        ? trigger.config.target
        : 'workflow';
    return { type: 'schedule', cron, timezone, target };
  }
  if (trigger.kind === 'webhook') {
    const path = typeof trigger.config.path === 'string' ? trigger.config.path : '';
    const method =
      trigger.config.method === 'GET' || trigger.config.method === 'POST'
        ? trigger.config.method
        : 'POST';
    return { type: 'webhook', path, method };
  }
  return { type: 'manual' };
}

function EmptyState({
  onSubmit,
  loading,
}: {
  onSubmit: (s: string) => void;
  loading: boolean;
}) {
  const [text, setText] = useState('');
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Every weekday at 9am, check my open PRs and send a summary to Slack…"
          className="w-full min-h-[120px] rounded-xl border border-neutral-300 px-4 py-3 text-sm"
        />
        <div className="flex justify-end mt-3">
          <button
            onClick={() => onSubmit(text)}
            disabled={loading || !text.trim()}
            className="px-5 py-2 bg-neutral-900 text-white rounded-lg text-sm font-medium hover:bg-neutral-800 disabled:opacity-50"
          >
            {loading ? 'Drafting…' : 'Draft workflow →'}
          </button>
        </div>
      </div>
    </div>
  );
}
