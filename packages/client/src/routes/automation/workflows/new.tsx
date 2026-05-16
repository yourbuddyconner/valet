import { useEffect, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  useDraftWorkflow,
  useDraftWorkflowStep,
  useSyncWorkflow,
  useWorkflow,
  type WorkflowData,
  type WorkflowStep,
} from '@/api/workflows';
import { useCreateTrigger, type TriggerConfig } from '@/api/triggers';
import { WorkflowDiagram } from '@/components/workflows/workflow-diagram';
import { WorkflowDraftTriggerForm } from '@/components/workflows/workflow-draft-trigger-form';
import { cn } from '@/lib/cn';

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

type ChatMessage =
  | { id: string; role: 'user'; content: string; targetIds: string[] }
  | { id: string; role: 'assistant'; content: string }
  | { id: string; role: 'error'; content: string };

type Tab = 'chat' | 'trigger' | 'json';

function NewWorkflowPage() {
  const nav = useNavigate();
  const { editId } = Route.useSearch();
  const existing = useWorkflow(editId ?? '');

  const [draft, setDraft] = useState<WorkflowData | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedStepIds, setSelectedStepIds] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<Tab>('chat');
  const [trigger, setTrigger] = useState<TriggerDraft | null>({ kind: 'manual', config: {} });
  const [saveError, setSaveError] = useState<string | null>(null);

  const draftMut = useDraftWorkflow();
  const stepMut = useDraftWorkflowStep();
  const syncMut = useSyncWorkflow();
  const createTrigger = useCreateTrigger();

  useEffect(() => {
    if (existing.data?.workflow && !draft) {
      setDraft(existing.data.workflow.data);
      setMessages([
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Loaded "${existing.data.workflow.name}" for editing.`,
        },
      ]);
    }
  }, [existing.data, draft]);

  const handleInitialDraft = (text: string) => {
    setMessages([{ id: crypto.randomUUID(), role: 'user', content: text, targetIds: [] }]);
    draftMut.mutate(
      { prompt: text },
      {
        onSuccess: (data) => {
          setDraft(data.workflow);
          setMessages((m) => [
            ...m,
            { id: crypto.randomUUID(), role: 'assistant', content: 'Draft ready.' },
          ]);
        },
        onError: (err) => {
          const errMsg = err instanceof Error ? err.message : 'Failed to draft workflow';
          setMessages((m) => [
            ...m,
            { id: crypto.randomUUID(), role: 'error', content: errMsg },
          ]);
        },
      },
    );
  };

  const handleRefine = (text: string) => {
    if (!draft) return;
    const targetIds = Array.from(selectedStepIds);
    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), role: 'user', content: text, targetIds },
    ]);
    const onSuccess = (data: { workflow: WorkflowData }) => {
      setDraft(data.workflow);
      setSelectedStepIds(new Set());
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            targetIds.length === 0
              ? 'Updated workflow.'
              : `Updated ${targetIds.length} step${targetIds.length === 1 ? '' : 's'}.`,
        },
      ]);
    };
    const onError = (err: unknown) => {
      const errMsg = err instanceof Error ? err.message : 'Refinement failed';
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: 'error', content: errMsg },
      ]);
    };
    if (targetIds.length === 0) {
      draftMut.mutate({ prompt: text, baseDraft: draft }, { onSuccess, onError });
    } else {
      stepMut.mutate(
        { workflow: draft, stepIds: targetIds, instruction: text },
        { onSuccess, onError },
      );
    }
  };

  const handleNodeClick = (stepId: string, opts: { modifier: boolean }) => {
    setSelectedStepIds((prev) => {
      if (opts.modifier) {
        const next = new Set(prev);
        if (next.has(stepId)) next.delete(stepId);
        else next.add(stepId);
        return next;
      }
      // No modifier: replace; clicking only-selected node deselects it.
      if (prev.size === 1 && prev.has(stepId)) return new Set();
      return new Set([stepId]);
    });
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

  const refining = draftMut.isPending || stepMut.isPending;

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 bg-white border-b border-neutral-200">
        <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / WORKFLOWS</div>
        <h1 className="text-xl font-semibold">{editId ? 'Edit workflow' : 'New workflow'}</h1>
      </header>

      {!draft ? (
        <EmptyState onSubmit={handleInitialDraft} loading={draftMut.isPending} />
      ) : (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          <div className="flex-1 min-w-0 bg-neutral-50 lg:overflow-hidden">
            <div className="h-[600px] lg:h-full">
              <WorkflowDiagram
                workflow={draft}
                mode="edit"
                selectedStepIds={selectedStepIds}
                onNodeClick={handleNodeClick}
              />
            </div>
          </div>

          <aside className="w-full lg:w-[380px] flex flex-col bg-white border-t lg:border-t-0 lg:border-l border-neutral-200 min-h-0">
            <div className="flex border-b border-neutral-200">
              {(['chat', 'trigger', 'json'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  aria-pressed={tab === t}
                  className={cn(
                    'flex-1 text-xs uppercase tracking-wider py-2.5 font-medium',
                    tab === t
                      ? 'text-neutral-900 border-b-2 border-neutral-900'
                      : 'text-neutral-500 hover:text-neutral-700 border-b-2 border-transparent',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-hidden">
              {tab === 'chat' && (
                <ChatPanel
                  workflow={draft}
                  messages={messages}
                  selectedStepIds={selectedStepIds}
                  onClearSelection={() => setSelectedStepIds(new Set())}
                  onRemoveSelection={(id) =>
                    setSelectedStepIds((prev) => {
                      const next = new Set(prev);
                      next.delete(id);
                      return next;
                    })
                  }
                  onSend={handleRefine}
                  refining={refining}
                />
              )}
              {tab === 'trigger' && (
                <div className="overflow-y-auto h-full">
                  <WorkflowDraftTriggerForm value={trigger} onChange={setTrigger} />
                </div>
              )}
              {tab === 'json' && (
                <pre className="text-xs bg-neutral-50 p-3 overflow-auto h-full font-mono whitespace-pre-wrap break-words">
                  {JSON.stringify(draft, null, 2)}
                </pre>
              )}
            </div>

            {saveError && (
              <div className="px-3 py-2 text-xs text-red-700 bg-red-50 border-t border-red-200">
                {saveError}
              </div>
            )}
            <div className="border-t border-neutral-200 p-3 flex gap-2">
              <button
                onClick={() => nav({ to: '/automation/workflows' })}
                className="flex-1 px-3 py-1.5 text-sm border border-neutral-300 rounded-md hover:bg-neutral-50"
              >
                Discard
              </button>
              <button
                onClick={handleSave}
                disabled={syncMut.isPending}
                className="flex-1 px-3 py-1.5 text-sm bg-emerald-700 text-white rounded-md font-medium hover:bg-emerald-800 disabled:opacity-50"
              >
                {syncMut.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function ChatPanel({
  workflow,
  messages,
  selectedStepIds,
  onClearSelection,
  onRemoveSelection,
  onSend,
  refining,
}: {
  workflow: WorkflowData;
  messages: ChatMessage[];
  selectedStepIds: ReadonlySet<string>;
  onClearSelection: () => void;
  onRemoveSelection: (id: string) => void;
  onSend: (text: string) => void;
  refining: boolean;
}) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const stepNames = new Map<string, string>();
  collectStepNames(workflow.steps, stepNames);

  return (
    <div className="h-full flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {messages.length === 0 && (
          <div className="text-xs text-neutral-500 text-center pt-6 px-2">
            Click a node to target it (⌘/Ctrl+click to add to selection), then ask the agent to
            refine.
          </div>
        )}
        {messages.map((m) => (
          <ChatMessageView key={m.id} message={m} stepNames={stepNames} />
        ))}
        {refining && <div className="text-xs text-neutral-500 italic">Drafting…</div>}
      </div>

      {selectedStepIds.size > 0 && (
        <div className="border-t border-neutral-200 px-3 py-2 bg-indigo-50">
          <div className="text-[10px] text-indigo-700 font-semibold tracking-wider mb-1.5 flex items-center justify-between">
            <span>
              TARGETING {selectedStepIds.size} STEP{selectedStepIds.size === 1 ? '' : 'S'}
            </span>
            <button
              onClick={onClearSelection}
              className="text-[10px] text-indigo-600 hover:text-indigo-900 normal-case font-normal"
            >
              clear
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {Array.from(selectedStepIds).map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 text-xs bg-white border border-indigo-300 text-indigo-800 px-1.5 py-0.5 rounded"
              >
                {stepNames.get(id) ?? id}
                <button
                  onClick={() => onRemoveSelection(id)}
                  className="text-indigo-500 hover:text-indigo-900"
                  aria-label={`Remove ${id} from selection`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-neutral-200 p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              selectedStepIds.size > 0
                ? 'Refine the selected step(s)…'
                : 'Refine the whole workflow…'
            }
            className="flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            disabled={refining}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim()) {
                onSend(text.trim());
                setText('');
              }
            }}
          />
          <button
            onClick={() => {
              if (text.trim()) {
                onSend(text.trim());
                setText('');
              }
            }}
            disabled={refining || !text.trim()}
            className="px-3 py-1.5 bg-neutral-900 text-white rounded-md text-sm font-medium disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatMessageView({
  message,
  stepNames,
}: {
  message: ChatMessage;
  stepNames: Map<string, string>;
}) {
  if (message.role === 'user') {
    return (
      <div className="bg-indigo-50 border-l-2 border-indigo-500 px-2.5 py-1.5 rounded-r text-xs">
        {message.targetIds.length > 0 && (
          <div className="text-[10px] text-indigo-700 mb-1">
            Targeting: {message.targetIds.map((id) => stepNames.get(id) ?? id).join(', ')}
          </div>
        )}
        <div className="text-neutral-800">{message.content}</div>
      </div>
    );
  }
  if (message.role === 'error') {
    return (
      <div className="bg-red-50 border-l-2 border-red-500 px-2.5 py-1.5 rounded-r text-xs text-red-800">
        {message.content}
      </div>
    );
  }
  return <div className="text-xs text-neutral-600 px-2.5">↳ {message.content}</div>;
}

function collectStepNames(steps: WorkflowStep[], map: Map<string, string>): void {
  for (const s of steps) {
    map.set(s.id, s.name || s.id);
    if (s.then) collectStepNames(s.then, map);
    if (s.else) collectStepNames(s.else, map);
    if (s.steps) collectStepNames(s.steps, map);
  }
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
