import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '@/stores/auth';
import { useCreateWorkflow, useWorkflows } from '@/api/workflows';
import { useTriggers } from '@/api/triggers';
import { useExecutions } from '@/api/executions';
import { toastError } from '@/hooks/use-toast';

export const Route = createFileRoute('/automation/')({
  component: AutomationLanding,
});

/**
 * Landing for the Automation section: a hero copilot prompt up top
 * (submitting creates a new workflow and jumps into the editor with
 * the copilot open, seeded with what the user typed), plus navigation
 * cards for Triggers / Workflows / Runs so people can drill into any
 * of the individual primitives.
 */
function AutomationLanding() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const createWorkflow = useCreateWorkflow();
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const triggersQuery = useTriggers();
  const workflowsQuery = useWorkflows();
  const executionsQuery = useExecutions();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = async () => {
    const text = prompt.trim();
    if (!text || createWorkflow.isPending) return;
    try {
      const response = await createWorkflow.mutateAsync({
        name: 'Untitled workflow',
      });
      // Kick into the editor with the copilot open and the prompt
      // pre-loaded as a search param — the editor reads it and hands
      // it off to the copilot panel as the first turn.
      void navigate({
        to: '/workflows/$workflowId',
        params: { workflowId: response.workflow.id },
        search: { copilot: 'open', prompt: text },
      });
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to start workflow');
    }
  };

  const greetingName = user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'there';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 py-8">
      <section className="flex flex-col items-center gap-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-neutral-950 dark:text-neutral-100">
            Welcome, {greetingName}. Got something in mind?
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Describe a workflow. The copilot will build the first draft you can iterate on.
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="w-full max-w-2xl"
        >
          <div className="group rounded-xl border border-neutral-200 bg-white shadow-sm transition-colors focus-within:border-violet-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus-within:border-violet-500">
            <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800/70">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-[10px] font-semibold text-violet-600 dark:text-violet-300">
                ✦
              </span>
              <span className="text-xs font-medium text-neutral-900 dark:text-neutral-100">Copilot</span>
              <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500">
                Enter to send · Shift+Enter for newline
              </span>
            </div>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={4}
              placeholder="e.g. When someone posts in #alerts, summarize the thread and email me every morning."
              className="w-full resize-none bg-transparent px-4 py-3 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
              disabled={createWorkflow.isPending}
            />
            <div className="flex items-center justify-end px-3 py-2">
              <button
                type="submit"
                disabled={!prompt.trim() || createWorkflow.isPending}
                className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-violet-700"
              >
                {createWorkflow.isPending ? 'Starting…' : 'Build workflow'}
              </button>
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
            Copilot is AI and can make mistakes. Review the workflow before publishing.
          </p>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          Inspect
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <NavCard
            to="/automation/triggers"
            title="Triggers"
            description="Schedules, webhooks, and manual entry points"
            count={triggersQuery.data?.triggers.length}
            icon={<TriggerIcon />}
          />
          <NavCard
            to="/automation/workflows"
            title="Workflows"
            description="Definitions and their published versions"
            count={workflowsQuery.data?.workflows.length}
            icon={<WorkflowIcon />}
          />
          <NavCard
            to="/automation/executions"
            title="Runs"
            description="Every execution and its trace"
            count={executionsQuery.data?.executions.length}
            icon={<RunIcon />}
          />
        </div>
      </section>
    </div>
  );
}

function NavCard({
  to,
  title,
  description,
  count,
  icon,
}: {
  to: '/automation/triggers' | '/automation/workflows' | '/automation/executions';
  title: string;
  description: string;
  count?: number;
  icon: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-neutral-300 hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-700"
    >
      <div className="flex items-center justify-between">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
          {icon}
        </span>
        {typeof count === 'number' && (
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-mono text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
            {count}
          </span>
        )}
      </div>
      <div>
        <h3 className="text-sm font-medium text-neutral-950 dark:text-neutral-100">{title}</h3>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{description}</p>
      </div>
    </Link>
  );
}

function TriggerIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </svg>
  );
}
function WorkflowIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v6a3 3 0 0 0 3 3h3" />
    </svg>
  );
}
function RunIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
