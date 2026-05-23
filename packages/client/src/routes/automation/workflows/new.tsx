import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowUp, PanelRightClose, PanelRightOpen, Plus, Sparkles, X } from 'lucide-react';
import {
  useDraftWorkflow,
  useDraftWorkflowStep,
  useSyncWorkflow,
  useTestRunWorkflow,
  useWorkflow,
  type WorkflowData,
  type WorkflowStep,
} from '@/api/workflows';
import { useCreateTrigger, type TriggerConfig } from '@/api/triggers';
import { WorkflowDiagram } from '@/components/workflows/workflow-diagram';
import { WorkflowDraftTriggerForm } from '@/components/workflows/workflow-draft-trigger-form';
import { WorkflowStepInspector } from '@/components/workflows/workflow-step-inspector';
import { WorkflowVariablesEditor } from '@/components/workflows/workflow-variables-editor';
import { RunWorkflowDialog } from '@/components/workflows/run-workflow-dialog';
import { TestRunPanel } from '@/components/workflows/test-run-panel';
import { WorkflowShell } from '@/components/workflows/workflow-shell';
import { CompactWorkflowHeader } from '@/components/workflows/compact-workflow-header';
import { StepTypePopover } from '@/components/workflows/workflow-diagram/nodes/step-type-popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  collectAllStepIds,
  insertAfter,
  insertInto,
  makeStepOfType,
  removeStep,
} from '@/lib/workflow-step-factory';

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

type Tab = 'inspect' | 'chat' | 'variables' | 'trigger' | 'json';

function NewWorkflowPage() {
  const nav = useNavigate();
  const { editId } = Route.useSearch();
  const existing = useWorkflow(editId ?? '');

  const [draft, setDraft] = useState<WorkflowData | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedStepIds, setSelectedStepIds] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<Tab>('inspect');
  const [trigger, setTrigger] = useState<TriggerDraft | null>({ kind: 'manual', config: {} });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Test-run state: dialog visibility, in-flight error, and the active test execution.
  const [showTestRunDialog, setShowTestRunDialog] = useState(false);
  const [testRunError, setTestRunError] = useState<string | null>(null);
  const [activeTestRun, setActiveTestRun] = useState<{ executionId: string; sessionId: string | null } | null>(null);
  // Empty-state "Add your first step" popover.
  const [firstStepOpen, setFirstStepOpen] = useState(false);

  const draftMut = useDraftWorkflow();
  const stepMut = useDraftWorkflowStep();
  const syncMut = useSyncWorkflow();
  const testRunMut = useTestRunWorkflow();
  const createTrigger = useCreateTrigger();

  // Ref into the chat panel input so the "ask the AI" CTA in the empty state
  // can focus it after switching to the chat tab.
  const chatInputRef = useRef<HTMLInputElement | null>(null);

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

  // Bootstrap a brand-new draft when the user clicks "Add your first step".
  // We create a tiny WorkflowData with one step so the rest of the page can
  // light up.
  const startBlankDraftWith = (type: WorkflowStep['type']) => {
    const id = crypto.randomUUID();
    const firstStep = makeStepOfType(type, new Set());
    setDraft({
      id,
      name: 'Untitled workflow',
      steps: [firstStep],
    });
    setSelectedStepIds(new Set([firstStep.id]));
    setTab('inspect');
  };

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
    if (!draft) {
      // First chat message with no draft → kick off the AI draft path.
      handleInitialDraft(text);
      return;
    }
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
    // Auto-show the inspector tab when a single step is targeted.
    if (!opts.modifier) setTab('inspect');
  };

  const handleStepPatch = (stepId: string, patch: Partial<WorkflowStep>) => {
    if (!draft) return;
    setDraft({ ...draft, steps: patchStep(draft.steps, stepId, patch) });
  };

  const handleInsertAfter = (targetStepId: string, type: WorkflowStep['type']) => {
    if (!draft) return;
    const newStep = makeStepOfType(type, collectAllStepIds(draft.steps));
    setDraft({ ...draft, steps: insertAfter(draft.steps, targetStepId, newStep) });
    setSelectedStepIds(new Set([newStep.id]));
    setTab('inspect');
  };

  const handleInsertInto = (
    containerId: string,
    slot: 'then' | 'else' | 'steps',
    type: WorkflowStep['type'],
  ) => {
    if (!draft) return;
    const newStep = makeStepOfType(type, collectAllStepIds(draft.steps));
    setDraft({ ...draft, steps: insertInto(draft.steps, containerId, slot, newStep) });
    setSelectedStepIds(new Set([newStep.id]));
    setTab('inspect');
  };

  const handleDeleteStep = (stepId: string) => {
    if (!draft) return;
    const step = findStep(draft.steps, stepId);
    const hasChildren = step
      ? (step.then && step.then.length > 0) ||
        (step.else && step.else.length > 0) ||
        (step.steps && step.steps.length > 0)
      : false;
    const label = step?.name ?? stepId;
    const msg = hasChildren
      ? `Delete "${label}" and all of its child steps?`
      : `Delete "${label}"?`;
    if (!confirm(msg)) return;
    setDraft({ ...draft, steps: removeStep(draft.steps, stepId) });
    setSelectedStepIds((prev) => {
      if (!prev.has(stepId)) return prev;
      const next = new Set(prev);
      next.delete(stepId);
      return next;
    });
  };

  const selectedStep = useMemo<WorkflowStep | null>(() => {
    if (!draft || selectedStepIds.size !== 1) return null;
    const [only] = selectedStepIds;
    return findStep(draft.steps, only);
  }, [draft, selectedStepIds]);

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
        // variableMapping is a top-level field on CreateTriggerRequest, not part of config.
        // The trigger form stores it transiently on config.variableMapping for convenience.
        const rawMapping = trigger.config.variableMapping;
        const variableMapping =
          rawMapping &&
          typeof rawMapping === 'object' &&
          !Array.isArray(rawMapping) &&
          Object.keys(rawMapping).length > 0
            ? (rawMapping as Record<string, string>)
            : undefined;
        await createTrigger.mutateAsync({
          workflowId: draft.id,
          name: `${draft.name} ${trigger.kind}`,
          enabled: true,
          config,
          variableMapping,
        });
      }
      nav({ to: '/automation/workflows/$workflowId', params: { workflowId: draft.id } });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save workflow.');
    }
  };

  const refining = draftMut.isPending || stepMut.isPending;

  // Dispatch a test/dry run with collected variables. If the draft has no declared
  // variables we skip the dialog and run immediately.
  const startTestRun = (values: Record<string, unknown>) => {
    if (!draft) return;
    setTestRunError(null);
    testRunMut.mutate(
      { data: draft, variables: values },
      {
        onSuccess: (res) => {
          setShowTestRunDialog(false);
          setActiveTestRun({ executionId: res.executionId, sessionId: res.sessionId });
        },
        onError: (err) => {
          setTestRunError(err instanceof Error ? err.message : 'Test run failed to start');
        },
      },
    );
  };

  const handleTestRunClick = () => {
    if (!draft) return;
    const hasVars = Object.keys(draft.variables ?? {}).length > 0;
    if (hasVars) {
      setShowTestRunDialog(true);
    } else {
      startTestRun({});
    }
  };

  const header = (
    <CompactWorkflowHeader
      title={
        draft
          ? draft.name || (editId ? 'Edit workflow' : 'New workflow')
          : editId
            ? 'Edit workflow'
            : 'New workflow'
      }
      badge={draft ? { label: 'Draft', variant: 'secondary' } : undefined}
      description={draft?.description ?? ''}
      meta={draft ? <span>v{draft.version ?? '1.0.0'}</span> : null}
    />
  );

  // Footer is the Save/Test/Discard action bar — only rendered once there's a
  // draft to act on.
  const footer = draft && sidebarOpen ? (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={handleTestRunClick}
        disabled={testRunMut.isPending || !!activeTestRun}
        className="flex-1"
      >
        {testRunMut.isPending ? 'Starting…' : 'Test run'}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => nav({ to: '/automation/workflows' })}
        className="flex-1"
      >
        Discard
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={handleSave}
        disabled={syncMut.isPending}
        className="flex-1"
      >
        {syncMut.isPending ? 'Saving…' : 'Save'}
      </Button>
    </>
  ) : undefined;

  const mainContent = draft ? (
    <>
      <div className="h-[640px] lg:h-auto lg:flex-1 lg:min-h-0">
        <WorkflowDiagram
          workflow={draft}
          mode="edit"
          selectedStepIds={selectedStepIds}
          onNodeClick={handleNodeClick}
          onInsertAfter={handleInsertAfter}
          onInsertInto={handleInsertInto}
          onDelete={handleDeleteStep}
        />
      </div>
      {!sidebarOpen && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSidebarOpen(true)}
          className="!absolute top-3 right-3 z-10 hidden lg:inline-flex"
          aria-label="Show sidebar"
        >
          <PanelRightOpen className="w-3.5 h-3.5 mr-1" />
          Sidebar
        </Button>
      )}
    </>
  ) : (
    <EmptyDiagram
      loading={draftMut.isPending}
      onPick={(type) => {
        setFirstStepOpen(false);
        startBlankDraftWith(type);
      }}
      open={firstStepOpen}
      setOpen={setFirstStepOpen}
      onFocusChat={() => {
        setTab('chat');
        // Defer focus until the chat tab has actually mounted.
        requestAnimationFrame(() => chatInputRef.current?.focus());
      }}
    />
  );

  const sidebar = sidebarOpen ? (
    <>
      <div className="flex border-b border-border items-stretch">
        {(['inspect', 'chat', 'variables', 'trigger', 'json'] as const).map((t) => {
          const variableCount = Object.keys(draft?.variables ?? {}).length;
          const label =
            t === 'variables' && variableCount > 0 ? `variables (${variableCount})` : t;
          // Tabs that operate on a draft (inspect/variables/trigger/json) are
          // disabled when there's no draft yet; chat is always available so
          // the user can ask the AI to draft.
          const disabled = !draft && t !== 'chat';
          return (
            <button
              key={t}
              onClick={() => !disabled && setTab(t)}
              aria-pressed={tab === t}
              disabled={disabled}
              className={cn(
                'flex-1 min-w-0 text-xs uppercase tracking-wider py-2.5 font-medium transition-colors',
                tab === t
                  ? 'text-foreground border-b-2 border-accent'
                  : 'text-neutral-500 hover:text-foreground border-b-2 border-transparent',
                disabled && 'opacity-40 cursor-not-allowed hover:text-neutral-500',
              )}
            >
              {label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          className="flex-shrink-0 px-2 text-neutral-500 hover:text-foreground hidden lg:inline-flex items-center"
          aria-label="Hide sidebar"
        >
          <PanelRightClose className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'inspect' &&
          (draft && selectedStep ? (
            <WorkflowStepInspector
              step={selectedStep}
              onChange={(patch) => handleStepPatch(selectedStep.id, patch)}
              workflow={draft}
            />
          ) : (
            <div className="h-full flex items-center justify-center px-6 text-xs text-neutral-500 dark:text-neutral-400 text-center">
              {!draft
                ? 'Add a step or ask the AI to draft a workflow.'
                : selectedStepIds.size === 0
                  ? 'Click a node to inspect its parameters.'
                  : `${selectedStepIds.size} steps selected — use the Chat tab to refine multiple steps at once.`}
            </div>
          ))}
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
            inputRef={chatInputRef}
          />
        )}
        {tab === 'variables' && draft && (
          <div className="h-full flex flex-col min-h-0">
            <div className="flex-1 min-h-0 overflow-hidden">
              <WorkflowVariablesEditor
                variables={draft.variables ?? {}}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    variables: Object.keys(next).length > 0 ? next : undefined,
                  })
                }
              />
            </div>
            <div className="border-t border-border px-4 py-3 space-y-1.5">
              <div className="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                Settings
              </div>
              <label className="text-xs text-foreground block">
                On failure (non-manual runs)
              </label>
              <div className="inline-flex rounded-md border border-border overflow-hidden">
                {(['orchestrator', 'none'] as const).map((option) => {
                  // Undefined defaults to 'orchestrator' on the server.
                  const current = draft.failureNotify ?? 'orchestrator';
                  const active = current === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          failureNotify: option,
                        })
                      }
                      aria-pressed={active}
                      className={cn(
                        'px-2.5 py-1 text-xs transition',
                        active
                          ? 'bg-accent text-white'
                          : 'bg-surface-2 text-foreground hover:bg-surface-3',
                      )}
                    >
                      {option === 'orchestrator'
                        ? 'Notify orchestrator on failure'
                        : 'No failure notifications'}
                    </button>
                  );
                })}
              </div>
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                Scheduled and webhook failures notify your orchestrator so it can react (Slack message, escalate, etc.).
              </div>
            </div>
          </div>
        )}
        {tab === 'trigger' && draft && (
          <div className="overflow-y-auto h-full">
            <WorkflowDraftTriggerForm
              value={trigger}
              onChange={setTrigger}
              availableVariables={draft.variables ?? {}}
            />
          </div>
        )}
        {tab === 'json' && draft && (
          <pre className="text-xs bg-surface-2 text-foreground p-3 overflow-auto h-full font-mono whitespace-pre-wrap break-words">
            {JSON.stringify(draft, null, 2)}
          </pre>
        )}
      </div>
    </>
  ) : null;

  return (
    <>
      <WorkflowShell
        header={header}
        main={mainContent}
        sidebar={sidebar}
        footer={footer}
        errorBanner={saveError ?? testRunError ?? undefined}
      />

      {showTestRunDialog && draft && (
        <RunWorkflowDialog
          name={draft.name}
          variables={draft.variables ?? {}}
          loading={testRunMut.isPending}
          confirmLabel="Start test run"
          title={`Test run ${draft.name}`}
          description="Provide sample values to execute this draft without saving. The test execution is excluded from the default executions list."
          onClose={() => {
            if (!testRunMut.isPending) setShowTestRunDialog(false);
          }}
          onConfirm={startTestRun}
        />
      )}

      {activeTestRun && (
        <TestRunPanel
          executionId={activeTestRun.executionId}
          sessionId={activeTestRun.sessionId}
          onClose={() => setActiveTestRun(null)}
        />
      )}
    </>
  );
}

// Diagram placeholder shown when there's no draft yet. A single "start" disc
// and a big "+ Add your first step" button below it, plus an AI-draft CTA.
function EmptyDiagram({
  loading,
  open,
  setOpen,
  onPick,
  onFocusChat,
}: {
  loading: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  onPick: (type: WorkflowStep['type']) => void;
  onFocusChat: () => void;
}) {
  const firstStepBtnRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="h-[640px] lg:h-auto lg:flex-1 lg:min-h-0 bg-surface-1 rounded-xl border border-border flex flex-col items-stretch px-6 py-4">
      {/* Banner sits at the top of the normal flow so it never overlaps the
          start disc on short viewports. */}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onFocusChat}
          className={cn(
            'flex items-center gap-1.5 text-[11px] text-neutral-500 hover:text-foreground transition',
          )}
        >
          <Sparkles className="w-3 h-3" strokeWidth={1.5} />
          <span>Build manually or ask the AI to draft from a prompt</span>
          <span aria-hidden="true">→</span>
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        {/* Mirror the synthetic start-node visual so the empty state feels like
            an extension of the diagram, not a separate screen. */}
        <div className="flex flex-col items-center">
          <div className="w-7 h-7 rounded-full bg-surface-2 border border-border-strong flex items-center justify-center text-neutral-500 shadow-panel">
            <span className="w-3 h-3 rounded-full bg-current" />
          </div>
          <div className="text-[9px] tracking-[0.18em] uppercase font-mono text-neutral-500 mt-1.5">
            START
          </div>
        </div>

        <div>
          <Button
            ref={firstStepBtnRef}
            variant="primary"
            size="lg"
            disabled={loading}
            onClick={() => setOpen(!open)}
          >
            <Plus className="w-4 h-4 mr-1.5" strokeWidth={2} />
            Add your first step
          </Button>
          {open && (
            <StepTypePopover
              anchorRef={firstStepBtnRef}
              title="Pick a step type"
              onClose={() => setOpen(false)}
              onPick={onPick}
            />
          )}
        </div>

        {loading && (
          <div className="text-xs text-neutral-500 italic">Drafting…</div>
        )}
      </div>
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
  inputRef,
}: {
  workflow: WorkflowData | null;
  messages: ChatMessage[];
  selectedStepIds: ReadonlySet<string>;
  onClearSelection: () => void;
  onRemoveSelection: (id: string) => void;
  onSend: (text: string) => void;
  refining: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const stepNames = new Map<string, string>();
  if (workflow) collectStepNames(workflow.steps, stepNames);

  const placeholder = !workflow
    ? 'Describe the workflow you want — e.g. "Every weekday at 9am, summarize my PRs to Slack"'
    : selectedStepIds.size > 0
      ? 'Refine the selected step(s)…'
      : 'Refine the whole workflow…';

  return (
    <div className="h-full flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {messages.length === 0 && (
          <div className="text-xs text-neutral-500 dark:text-neutral-400 text-center pt-6 px-2">
            {!workflow
              ? 'Describe the workflow you want and the agent will draft it. Or close this panel and build manually with the + buttons.'
              : 'Click a node to target it (⌘/Ctrl+click to add to selection), then ask the agent to refine.'}
          </div>
        )}
        {messages.map((m) => (
          <ChatMessageView key={m.id} message={m} stepNames={stepNames} />
        ))}
        {refining && <div className="text-xs text-neutral-500 dark:text-neutral-400 italic">Drafting…</div>}
      </div>

      {selectedStepIds.size > 0 && (
        <div className="border-t border-border px-3 py-2 bg-accent/10">
          <div className="text-[10px] text-accent font-semibold tracking-wider mb-1.5 flex items-center justify-between">
            <span>
              TARGETING {selectedStepIds.size} STEP{selectedStepIds.size === 1 ? '' : 'S'}
            </span>
            <button
              onClick={onClearSelection}
              className="text-[10px] text-accent hover:opacity-80 normal-case font-normal"
            >
              clear
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {Array.from(selectedStepIds).map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 text-xs bg-surface-0 border border-accent/40 text-accent px-1.5 py-0.5 rounded"
              >
                {stepNames.get(id) ?? id}
                <button
                  onClick={() => onRemoveSelection(id)}
                  className="text-accent/70 hover:text-accent"
                  aria-label={`Remove ${id} from selection`}
                >
                  <X className="w-3 h-3" strokeWidth={1.5} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border p-3">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            className="flex-1 rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition"
            disabled={refining}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim()) {
                onSend(text.trim());
                setText('');
              }
            }}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              if (text.trim()) {
                onSend(text.trim());
                setText('');
              }
            }}
            disabled={refining || !text.trim()}
          >
            <ArrowUp className="w-3.5 h-3.5" strokeWidth={1.5} />
            Send
          </Button>
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
      <div className="bg-accent/10 border-l-2 border-accent px-2.5 py-1.5 rounded-r text-xs">
        {message.targetIds.length > 0 && (
          <div className="text-[10px] text-accent mb-1">
            Targeting: {message.targetIds.map((id) => stepNames.get(id) ?? id).join(', ')}
          </div>
        )}
        <div className="text-foreground">{message.content}</div>
      </div>
    );
  }
  if (message.role === 'error') {
    return (
      <div className="bg-red-500/10 border-l-2 border-red-500 px-2.5 py-1.5 rounded-r text-xs text-red-600 dark:text-red-400">
        {message.content}
      </div>
    );
  }
  return <div className="text-xs text-neutral-500 dark:text-neutral-400 px-2.5">↳ {message.content}</div>;
}

function findStep(steps: WorkflowStep[], id: string): WorkflowStep | null {
  for (const s of steps) {
    if (s.id === id) return s;
    const inner =
      (s.then && findStep(s.then, id)) ||
      (s.else && findStep(s.else, id)) ||
      (s.steps && findStep(s.steps, id));
    if (inner) return inner;
  }
  return null;
}

function patchStep(
  steps: WorkflowStep[],
  id: string,
  patch: Partial<WorkflowStep>,
): WorkflowStep[] {
  return steps.map((s) => {
    if (s.id === id) return { ...s, ...patch };
    let next: WorkflowStep = s;
    if (s.then) next = { ...next, then: patchStep(s.then, id, patch) };
    if (s.else) next = { ...next, else: patchStep(s.else, id, patch) };
    if (s.steps) next = { ...next, steps: patchStep(s.steps, id, patch) };
    return next;
  });
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
