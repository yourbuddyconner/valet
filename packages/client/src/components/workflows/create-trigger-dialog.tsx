import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useCreateTrigger, type CreateTriggerRequest, type TriggerConfig } from '@/api/triggers';
import { useWorkflows, type Workflow, type VariableDefinition } from '@/api/workflows';
import { useRepos } from '@/api/repos';
import { humanizeCron } from './cron-humanize';
import { cn } from '@/lib/cn';

// Use the shared union types. `ScheduleConfig.variables` and the `GitHubConfig`
// variant both live in @/api/triggers now.
type GitHubTriggerConfig = Extract<TriggerConfig, { type: 'github' }>;
type ScheduleConfigWithVars = Extract<TriggerConfig, { type: 'schedule' }>;

type Path = 'schedule-prompt' | 'schedule-workflow' | 'webhook' | 'github';

const INPUT_BASE =
  'w-full rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition';

const DEFAULT_CRON = '0 9 * * *';
const DEFAULT_TZ = 'America/Los_Angeles';

const GITHUB_EVENT_OPTIONS: { id: string; label: string; group: string }[] = [
  { id: 'pull_request.opened', label: 'PR opened', group: 'pull_request' },
  { id: 'pull_request.closed', label: 'PR closed', group: 'pull_request' },
  { id: 'pull_request.synchronize', label: 'PR synchronize', group: 'pull_request' },
  { id: 'pull_request.reopened', label: 'PR reopened', group: 'pull_request' },
  // Synthetic event: the GitHub webhook actually fires `pull_request.closed`
  // with `pull_request.merged === true`. We surface it as its own option for
  // user clarity; the worker / dispatcher is expected to map it correctly.
  { id: 'pull_request.merged', label: 'PR merged', group: 'pull_request' },
  { id: 'push', label: 'Push', group: 'push' },
  { id: 'issues.opened', label: 'Issue opened', group: 'issues' },
  { id: 'issues.closed', label: 'Issue closed', group: 'issues' },
  { id: 'release.published', label: 'Release published', group: 'release' },
  { id: 'workflow_run.completed', label: 'Workflow run completed', group: 'workflow_run' },
];

// Common GitHub payload paths we pre-fill when a workflow declares a matching
// variable name. Users can edit or clear them.
const GITHUB_DEFAULT_MAPPINGS: Record<string, string> = {
  pr_number: '$.pull_request.number',
  pr_title: '$.pull_request.title',
  pr_url: '$.pull_request.html_url',
  pr_branch: '$.pull_request.head.ref',
  action: '$.action',
  repo: '$.repository.full_name',
  actor: '$.sender.login',
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CreateTriggerDialog({ open, onClose }: Props) {
  const [path, setPath] = React.useState<Path>('schedule-prompt');

  // Reset path when reopening so we don't leak the prior selection.
  React.useEffect(() => {
    if (open) setPath('schedule-prompt');
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New trigger</DialogTitle>
          <DialogDescription>
            Pick how this trigger should fire. Each option configures a different runtime.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4">
          <PathSelector value={path} onChange={setPath} />
        </div>

        <div className="mt-5">
          {path === 'schedule-prompt' && <SchedulePromptForm onClose={onClose} />}
          {path === 'schedule-workflow' && <ScheduleWorkflowForm onClose={onClose} />}
          {path === 'webhook' && <WebhookForm onClose={onClose} />}
          {path === 'github' && <GitHubForm onClose={onClose} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PathSelector({ value, onChange }: { value: Path; onChange: (p: Path) => void }) {
  const items: { id: Path; label: string; sub: string }[] = [
    { id: 'schedule-prompt', label: 'Schedule prompt', sub: 'Prompt your orchestrator on a cron' },
    { id: 'schedule-workflow', label: 'Schedule workflow', sub: 'Run a workflow on a cron' },
    { id: 'webhook', label: 'Webhook', sub: 'Trigger from a URL' },
    { id: 'github', label: 'GitHub event', sub: 'Fire on GitHub events' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {items.map(({ id, label, sub }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            className={cn(
              'text-left rounded-md border px-3 py-2 transition-colors',
              active
                ? 'border-accent bg-accent/10 text-foreground'
                : 'border-border bg-surface-0 dark:bg-surface-2 text-neutral-700 dark:text-neutral-300 hover:border-accent/50',
            )}
          >
            <div className="text-xs font-mono uppercase tracking-wider">{label}</div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">{sub}</div>
          </button>
        );
      })}
    </div>
  );
}

// ---------- Path 1: Schedule prompt ----------

function SchedulePromptForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [cron, setCron] = React.useState(DEFAULT_CRON);
  const [timezone, setTimezone] = React.useState(DEFAULT_TZ);
  const [error, setError] = React.useState<string | null>(null);
  const createTrigger = useCreateTrigger();

  const cronPreview = humanizeCron(cron);
  const cronValid = cronPreview !== null;
  const canSubmit =
    name.trim().length > 0 && prompt.trim().length > 0 && cron.trim().length > 0 && cronValid;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);
    const config: ScheduleConfigWithVars = {
      type: 'schedule',
      cron: cron.trim(),
      timezone: timezone.trim() || undefined,
      target: 'orchestrator',
      prompt: prompt.trim(),
    };
    const req: CreateTriggerRequest = {
      name: name.trim(),
      config,
    };
    createTrigger.mutate(req, {
      onSuccess: () => onClose(),
      onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Failed to create trigger.'),
    });
  };

  return (
    <FormShell
      submitLabel={createTrigger.isPending ? 'Creatingâ¦' : 'Create schedule'}
      submitDisabled={!canSubmit || createTrigger.isPending}
      onCancel={onClose}
      onSubmit={handleSubmit}
      error={error}
    >
      <NameField value={name} onChange={setName} />
      <Field label="Prompt" required>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="Tell your orchestrator what to do when this fires."
          className={INPUT_BASE}
        />
      </Field>
      <CronAndTimezone
        cron={cron}
        setCron={setCron}
        timezone={timezone}
        setTimezone={setTimezone}
        preview={cronPreview}
      />
    </FormShell>
  );
}

// ---------- Path 2: Schedule workflow ----------

function ScheduleWorkflowForm({ onClose }: { onClose: () => void }) {
  const { data: workflowsData } = useWorkflows();
  const workflows = workflowsData?.workflows ?? [];
  const [name, setName] = React.useState('');
  const [workflowId, setWorkflowId] = React.useState('');
  const [cron, setCron] = React.useState(DEFAULT_CRON);
  const [timezone, setTimezone] = React.useState(DEFAULT_TZ);
  const [variables, setVariables] = React.useState<Record<string, unknown>>({});
  const [variableErrors, setVariableErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const createTrigger = useCreateTrigger();

  const selectedWorkflow = workflows.find((w) => w.id === workflowId);
  const declaredVariables = selectedWorkflow?.data.variables ?? {};
  const hasVariables = Object.keys(declaredVariables).length > 0;

  const cronPreview = humanizeCron(cron);
  const cronValid = cronPreview !== null;
  const hasVariableErrors = Object.keys(variableErrors).length > 0;
  const canSubmit =
    name.trim().length > 0 &&
    workflowId.length > 0 &&
    cron.trim().length > 0 &&
    cronValid &&
    !hasVariableErrors;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);
    const config: ScheduleConfigWithVars = {
      type: 'schedule',
      cron: cron.trim(),
      timezone: timezone.trim() || undefined,
      target: 'workflow',
      variables: hasVariables && Object.keys(variables).length > 0 ? variables : undefined,
    };
    createTrigger.mutate(
      {
        workflowId,
        name: name.trim(),
        config,
      },
      {
        onSuccess: () => onClose(),
        onError: (e: unknown) =>
          setError(e instanceof Error ? e.message : 'Failed to create trigger.'),
      },
    );
  };

  return (
    <FormShell
      submitLabel={createTrigger.isPending ? 'Creatingâ¦' : 'Create schedule'}
      submitDisabled={!canSubmit || createTrigger.isPending}
      onCancel={onClose}
      onSubmit={handleSubmit}
      error={error}
    >
      <NameField value={name} onChange={setName} />
      <WorkflowSelect value={workflowId} onChange={setWorkflowId} workflows={workflows} />
      <CronAndTimezone
        cron={cron}
        setCron={setCron}
        timezone={timezone}
        setTimezone={setTimezone}
        preview={cronPreview}
      />
      {hasVariables && (
        <Field label="Default variables">
          <VariableInputs
            variables={declaredVariables}
            values={variables}
            onChange={setVariables}
            onErrorsChange={setVariableErrors}
          />
        </Field>
      )}
    </FormShell>
  );
}

// ---------- Path 3: Webhook ----------

function WebhookForm({ onClose }: { onClose: () => void }) {
  const { data: workflowsData } = useWorkflows();
  const workflows = workflowsData?.workflows ?? [];
  const [name, setName] = React.useState('');
  const [workflowId, setWorkflowId] = React.useState('');
  const [hookPath, setHookPath] = React.useState('');
  const [method, setMethod] = React.useState<'GET' | 'POST'>('POST');
  const [mapping, setMapping] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const createTrigger = useCreateTrigger();

  const selectedWorkflow = workflows.find((w) => w.id === workflowId);
  const declaredVariables = selectedWorkflow?.data.variables ?? {};

  const pathValid = /^[a-zA-Z0-9-]+$/.test(hookPath);
  const pathError = hookPath.length === 0 ? 'Required' : pathValid ? null : 'Use letters, numbers, and dashes only.';
  const canSubmit = name.trim().length > 0 && workflowId.length > 0 && pathValid;

  // Build the preview URL from the deployed worker origin. window.location.origin
  // is the right approximation for both local dev and prod since the client
  // and worker are served from the same domain in production.
  const workerOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);
    createTrigger.mutate(
      {
        workflowId,
        name: name.trim(),
        config: { type: 'webhook', path: hookPath, method },
        variableMapping: Object.keys(mapping).length > 0 ? mapping : undefined,
      },
      {
        onSuccess: () => onClose(),
        onError: (e: unknown) =>
          setError(e instanceof Error ? e.message : 'Failed to create trigger.'),
      },
    );
  };

  return (
    <FormShell
      submitLabel={createTrigger.isPending ? 'Creatingâ¦' : 'Create webhook'}
      submitDisabled={!canSubmit || createTrigger.isPending}
      onCancel={onClose}
      onSubmit={handleSubmit}
      error={error}
    >
      <NameField value={name} onChange={setName} />
      <WorkflowSelect value={workflowId} onChange={setWorkflowId} workflows={workflows} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Path" required error={hookPath.length > 0 ? pathError : null}>
          <input
            type="text"
            value={hookPath}
            onChange={(e) => setHookPath(e.target.value)}
            placeholder="my-trigger"
            className={INPUT_BASE + ' font-mono'}
          />
          {hookPath.length > 0 && pathValid && (
            <div className="text-[11px] text-neutral-500 mt-1 font-mono">
              {workerOrigin}/webhooks/{hookPath}
            </div>
          )}
        </Field>
        <Field label="Method">
          <SegmentedControl
            options={[
              { id: 'POST', label: 'POST' },
              { id: 'GET', label: 'GET' },
            ]}
            value={method}
            onChange={(v) => setMethod(v as 'GET' | 'POST')}
          />
        </Field>
      </div>
      <Field label="Variable mapping (optional)">
        <VariableMappingRows
          variables={declaredVariables}
          mapping={mapping}
          onChange={setMapping}
        />
      </Field>
    </FormShell>
  );
}

// ---------- Path 4: GitHub event ----------

function GitHubForm({ onClose }: { onClose: () => void }) {
  const { data: workflowsData } = useWorkflows();
  const workflows = workflowsData?.workflows ?? [];
  const { data: reposData, isLoading: reposLoading } = useRepos();
  const repos = reposData?.repos ?? [];

  const [name, setName] = React.useState('');
  const [workflowId, setWorkflowId] = React.useState('');
  const [selectedRepos, setSelectedRepos] = React.useState<string[]>([]);
  const [selectedEvents, setSelectedEvents] = React.useState<string[]>([]);
  const [matchAllPR, setMatchAllPR] = React.useState(false);
  const [showFilters, setShowFilters] = React.useState(false);
  const [filterBranch, setFilterBranch] = React.useState('');
  const [filterLabels, setFilterLabels] = React.useState('');
  const [filterActions, setFilterActions] = React.useState('');
  const [mapping, setMapping] = React.useState<Record<string, string>>({});
  const [mappingPrefilled, setMappingPrefilled] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const createTrigger = useCreateTrigger();

  const selectedWorkflow = workflows.find((w) => w.id === workflowId);
  const declaredVariables = selectedWorkflow?.data.variables ?? {};

  // First time the user selects a workflow with declared vars, pre-populate the
  // mapping with common GitHub paths for any variables that have matching names.
  React.useEffect(() => {
    if (mappingPrefilled) return;
    if (!selectedWorkflow) return;
    const declared = Object.keys(selectedWorkflow.data.variables ?? {});
    if (declared.length === 0) return;
    const preset: Record<string, string> = {};
    for (const varName of declared) {
      const defaultPath = GITHUB_DEFAULT_MAPPINGS[varName];
      if (defaultPath) preset[varName] = defaultPath;
    }
    if (Object.keys(preset).length > 0) {
      setMapping((prev) => ({ ...preset, ...prev }));
    }
    setMappingPrefilled(true);
  }, [selectedWorkflow, mappingPrefilled]);

  // Re-allow prefilling if the user clears the workflow selection.
  React.useEffect(() => {
    if (!workflowId) setMappingPrefilled(false);
  }, [workflowId]);

  const events = matchAllPR
    ? // Replace any specific pull_request.* selections with the broad event.
      ['pull_request', ...selectedEvents.filter((e) => !e.startsWith('pull_request'))]
    : selectedEvents;

  const showActionsFilter = events.includes('pull_request') || events.includes('issues');
  const canSubmit =
    name.trim().length > 0 &&
    workflowId.length > 0 &&
    selectedRepos.length > 0 &&
    events.length > 0;

  const toggleRepo = (fullName: string) => {
    setSelectedRepos((prev) =>
      prev.includes(fullName) ? prev.filter((r) => r !== fullName) : [...prev, fullName],
    );
  };

  const toggleEvent = (id: string) => {
    setSelectedEvents((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id],
    );
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);
    const filter: GitHubTriggerConfig['filter'] = {};
    if (filterBranch.trim()) filter.branch = filterBranch.trim();
    if (filterLabels.trim()) {
      filter.labels = filterLabels.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (showActionsFilter && filterActions.trim()) {
      filter.actions = filterActions.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const config: GitHubTriggerConfig = {
      type: 'github',
      repos: selectedRepos,
      events,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    };
    createTrigger.mutate(
      {
        workflowId,
        name: name.trim(),
        config,
      },
      {
        onSuccess: () => onClose(),
        onError: (e: unknown) =>
          setError(e instanceof Error ? e.message : 'Failed to create trigger.'),
      },
    );
  };

  return (
    <FormShell
      submitLabel={createTrigger.isPending ? 'Creatingâ¦' : 'Create GitHub trigger'}
      submitDisabled={!canSubmit || createTrigger.isPending}
      onCancel={onClose}
      onSubmit={handleSubmit}
      error={error}
    >
      <NameField value={name} onChange={setName} />
      <WorkflowSelect value={workflowId} onChange={setWorkflowId} workflows={workflows} />

      <Field label="Repositories" required>
        {reposLoading ? (
          <div className="text-xs text-neutral-500">Loading reposâ¦</div>
        ) : repos.length === 0 ? (
          <div className="text-xs text-neutral-500 italic bg-surface-2 border border-border rounded-md px-3 py-2">
            Install the GitHub App on a repo to enable this trigger.{' '}
            <a href="/integrations" className="text-accent hover:underline">
              Go to integrations
            </a>
            .
          </div>
        ) : (
          <div className="max-h-40 overflow-y-auto border border-border rounded-md divide-y divide-border">
            {repos.map((repo) => (
              <label
                key={repo.id}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
              >
                <Checkbox
                  checked={selectedRepos.includes(repo.fullName)}
                  onChange={() => toggleRepo(repo.fullName)}
                />
                <span className="font-mono text-xs text-foreground">{repo.fullName}</span>
                {repo.private && (
                  <Badge variant="secondary" className="ml-auto">
                    private
                  </Badge>
                )}
              </label>
            ))}
          </div>
        )}
      </Field>

      <Field label="Events" required>
        <label className="flex items-center gap-2 mb-2 text-xs">
          <Checkbox
            checked={matchAllPR}
            onChange={(e) => setMatchAllPR(e.target.checked)}
          />
          <span className="text-neutral-700 dark:text-neutral-300">
            Any <span className="font-mono">pull_request.*</span> (collapses individual PR events)
          </span>
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {GITHUB_EVENT_OPTIONS.map((opt) => {
            const isPR = opt.group === 'pull_request';
            const disabled = matchAllPR && isPR;
            return (
              <label
                key={opt.id}
                className={cn(
                  'flex items-center gap-2 px-2 py-1 rounded text-xs',
                  disabled
                    ? 'opacity-40 cursor-not-allowed'
                    : 'hover:bg-surface-2 cursor-pointer',
                )}
              >
                <Checkbox
                  checked={!disabled && selectedEvents.includes(opt.id)}
                  disabled={disabled}
                  onChange={() => toggleEvent(opt.id)}
                />
                <span className="font-mono text-foreground">{opt.id}</span>
                <span className="text-neutral-500">{opt.label}</span>
              </label>
            );
          })}
        </div>
      </Field>

      <div>
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          className="text-xs text-neutral-500 hover:text-foreground uppercase tracking-wider"
        >
          {showFilters ? '▾' : '▸'} Filters (optional)
        </button>
        {showFilters && (
          <div className="mt-2 space-y-3 pl-3 border-l border-border">
            <Field label="Branch">
              <input
                type="text"
                value={filterBranch}
                onChange={(e) => setFilterBranch(e.target.value)}
                placeholder="main, develop"
                className={INPUT_BASE + ' font-mono'}
              />
            </Field>
            <Field label="Labels (comma-separated)">
              <input
                type="text"
                value={filterLabels}
                onChange={(e) => setFilterLabels(e.target.value)}
                placeholder="bug, enhancement"
                className={INPUT_BASE + ' font-mono'}
              />
            </Field>
            {showActionsFilter && (
              <Field label="Actions (comma-separated)">
                <input
                  type="text"
                  value={filterActions}
                  onChange={(e) => setFilterActions(e.target.value)}
                  placeholder="opened, closed"
                  className={INPUT_BASE + ' font-mono'}
                />
              </Field>
            )}
          </div>
        )}
      </div>

      <Field label="Variable mapping (optional)">
        <VariableMappingRows
          variables={declaredVariables}
          mapping={mapping}
          onChange={setMapping}
        />
      </Field>
    </FormShell>
  );
}

// ---------- Shared subcomponents ----------

function FormShell({
  children,
  onCancel,
  onSubmit,
  submitLabel,
  submitDisabled,
  error,
}: {
  children: React.ReactNode;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitDisabled: boolean;
  error: string | null;
}) {
  return (
    <div className="space-y-4">
      {children}
      {error && <div className="text-xs text-red-500">{error}</div>}
      <DialogFooter className="pt-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={onSubmit} disabled={submitDisabled}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </div>
  );
}

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] text-neutral-500 dark:text-neutral-400 tracking-wider mb-1">
        {label.toUpperCase()}
        {required && <span className="text-red-500 ml-1">*</span>}
      </div>
      {children}
      {error && <div className="text-xs text-red-500 mt-1">{error}</div>}
    </div>
  );
}

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Name" required>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Daily standup digest"
      />
    </Field>
  );
}

function WorkflowSelect({
  value,
  onChange,
  workflows,
}: {
  value: string;
  onChange: (id: string) => void;
  workflows: Workflow[];
}) {
  return (
    <Field label="Workflow" required>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_BASE}
      >
        <option value="">Select a workflowâ¦</option>
        {workflows.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function CronAndTimezone({
  cron,
  setCron,
  timezone,
  setTimezone,
  preview,
}: {
  cron: string;
  setCron: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  preview: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Cron" required error={cron.trim() && preview === null ? 'Invalid cron expression' : null}>
        <input
          type="text"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          className={INPUT_BASE + ' font-mono'}
        />
        {preview && <div className="text-[11px] text-neutral-500 mt-1">{preview}</div>}
      </Field>
      <Field label="Timezone">
        <input
          type="text"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className={INPUT_BASE}
        />
      </Field>
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex bg-surface-2 rounded-md p-0.5 w-full">
      {options.map(({ id, label }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            className={cn(
              'flex-1 px-3 py-1 text-xs font-mono uppercase tracking-wider rounded transition-colors',
              active
                ? 'bg-surface-0 text-foreground shadow-panel'
                : 'text-neutral-500 hover:text-foreground',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function VariableMappingRows({
  variables,
  mapping,
  onChange,
}: {
  variables: Record<string, VariableDefinition>;
  mapping: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const entries = Object.entries(variables);
  if (entries.length === 0) {
    return (
      <div className="text-xs text-neutral-500 dark:text-neutral-400 italic bg-surface-2 border border-border rounded-md px-3 py-2">
        Selected workflow declares no variables. Add variables on the workflow to map them here.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Map workflow variables to JSON paths in the payload. Use{' '}
        <span className="font-mono">$.field</span> or{' '}
        <span className="font-mono">$.nested.field</span> syntax.
      </p>
      {entries.map(([varName, def]) => (
        <MappingRow
          key={varName}
          varName={varName}
          def={def}
          initialValue={mapping[varName] ?? ''}
          onCommit={(nextPath) => {
            const next = { ...mapping };
            const trimmed = nextPath.trim();
            if (trimmed) next[varName] = trimmed;
            else delete next[varName];
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

// Local row with internal text state so we only push up on blur — avoids
// re-rendering the whole parent form on every keystroke.
function MappingRow({
  varName,
  def,
  initialValue,
  onCommit,
}: {
  varName: string;
  def: VariableDefinition;
  initialValue: string;
  onCommit: (next: string) => void;
}) {
  // The `key` from the parent (varName) is stable, so this defaultValue is a
  // one-shot starting point and we don't need useEffect to resync.
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 w-40 shrink-0">
        <span className="font-mono text-xs text-foreground truncate">{varName}</span>
        <Badge variant="secondary">{def.type}</Badge>
      </div>
      <input
        type="text"
        defaultValue={initialValue}
        onBlur={(e) => onCommit(e.target.value)}
        placeholder="$.payload.path"
        className={INPUT_BASE + ' font-mono'}
      />
    </div>
  );
}

// VariableInputs renders typed inputs (string / number / boolean / json) for
// the workflow's declared variables, parsing on the fly and surfacing per-field
// errors. Mirrors the pattern in run-workflow-dialog.tsx; kept local because
// extracting it as a shared module would require touching that file too.
function VariableInputs({
  variables,
  values,
  onChange,
  onErrorsChange,
}: {
  variables: Record<string, VariableDefinition>;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onErrorsChange: (next: Record<string, string>) => void;
}) {
  // Track raw inputs so we can render and parse independently — strings keep
  // typing fidelity, JSON inputs keep partial state, etc.
  const [raw, setRaw] = React.useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [name, def] of Object.entries(variables)) {
      if (def.default === undefined || def.default === null) {
        initial[name] = '';
        continue;
      }
      if (def.type === 'array' || def.type === 'object') {
        initial[name] = JSON.stringify(def.default, null, 2);
      } else if (def.type === 'boolean') {
        initial[name] = '';
      } else {
        initial[name] = String(def.default);
      }
    }
    return initial;
  });

  const [checked, setChecked] = React.useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const [name, def] of Object.entries(variables)) {
      if (def.type === 'boolean') {
        initial[name] = typeof def.default === 'boolean' ? def.default : false;
      }
    }
    return initial;
  });

  // Recompute parsed values + errors whenever raw inputs change.
  React.useEffect(() => {
    const nextValues: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};
    for (const [name, def] of Object.entries(variables)) {
      const required = def.required === true;
      if (def.type === 'boolean') {
        nextValues[name] = checked[name] ?? false;
        continue;
      }
      const rawVal = (raw[name] ?? '').trim();
      if (rawVal.length === 0) {
        if (required) nextErrors[name] = 'Required';
        continue;
      }
      if (def.type === 'number') {
        const n = Number(rawVal);
        if (!Number.isFinite(n)) nextErrors[name] = 'Must be a number';
        else nextValues[name] = n;
        continue;
      }
      if (def.type === 'array' || def.type === 'object') {
        try {
          const parsed: unknown = JSON.parse(rawVal);
          if (def.type === 'array' && !Array.isArray(parsed)) {
            nextErrors[name] = 'Must be a JSON array';
          } else if (
            def.type === 'object' &&
            (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
          ) {
            nextErrors[name] = 'Must be a JSON object';
          } else {
            nextValues[name] = parsed;
          }
        } catch {
          nextErrors[name] = 'Invalid JSON';
        }
        continue;
      }
      // string
      nextValues[name] = rawVal;
    }
    onChange(nextValues);
    onErrorsChange(nextErrors);
    // We intentionally exclude onChange/onErrorsChange from deps — they're
    // referentially-unstable parent setters and would loop the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, checked, variables]);

  return (
    <div className="space-y-3">
      {Object.entries(variables).map(([name, def]) => {
        const inputId = `tvar-${name}`;
        const useTextarea = def.type === 'array' || def.type === 'object';
        return (
          <div
            key={name}
            className="space-y-1 bg-surface-2 border border-border rounded-md p-2"
          >
            <div className="flex items-center gap-2">
              <label htmlFor={inputId} className="font-mono text-xs text-foreground">
                {name}
              </label>
              <Badge variant="secondary">{def.type}</Badge>
              {def.required && <span className="text-red-500 text-xs">*</span>}
            </div>
            {def.description && (
              <div className="text-[11px] text-neutral-500">{def.description}</div>
            )}
            {def.type === 'boolean' ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={inputId}
                  checked={!!checked[name]}
                  onChange={(e) =>
                    setChecked((prev) => ({ ...prev, [name]: e.target.checked }))
                  }
                />
                <label htmlFor={inputId} className="text-xs text-neutral-700 dark:text-neutral-300">
                  {checked[name] ? 'true' : 'false'}
                </label>
              </div>
            ) : useTextarea ? (
              <textarea
                id={inputId}
                value={raw[name] ?? ''}
                onChange={(e) => setRaw((prev) => ({ ...prev, [name]: e.target.value }))}
                rows={4}
                className={INPUT_BASE + ' font-mono'}
                placeholder={def.type === 'array' ? '[]' : '{}'}
              />
            ) : (
              <Input
                id={inputId}
                type={def.type === 'number' ? 'number' : 'text'}
                value={raw[name] ?? ''}
                onChange={(e) => setRaw((prev) => ({ ...prev, [name]: e.target.value }))}
              />
            )}
            {values[name] === undefined && def.required && (
              <div className="text-[11px] text-red-500">Required</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
