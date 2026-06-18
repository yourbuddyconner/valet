import * as React from 'react';
import { Link } from '@tanstack/react-router';
import {
  type Trigger,
  type TriggerConfig,
  type WebhookConfig,
  type ScheduleConfig,
  type CreateTriggerRequest,
  useTriggers,
  useCreateTrigger,
  useDeleteTrigger,
  useDisableTrigger,
  useEnableTrigger,
  useRunTrigger,
  useUpdateTrigger,
} from '@/api/triggers';
import { useWorkflowDraft, useWorkflows } from '@/api/workflows';
import {
  ManualWorkflowDialog,
  type ManualWorkflowPayload,
} from '@/components/workflows/manual-workflow-dialog';
import {
  createWorkflowInputFields,
  parseWorkflowInputFields,
  type ManualWorkflowInputField,
} from '@/components/workflows/manual-workflow-dialog-model';
import { ScheduledWorkflowInputs } from '@/components/workflows/scheduled-workflow-inputs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchInput } from '@/components/ui/search-input';
import { cn } from '@/lib/cn';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';
import { WebhookTokenReveal } from './webhook-token-reveal';

/* ─── Types ─── */

type TriggerType = 'manual' | 'webhook' | 'schedule';
type ScheduleTarget = 'workflow' | 'orchestrator';

interface TriggerFormState {
  name: string;
  enabled: boolean;
  type: TriggerType;
  workflowId: string;
  webhookPath: string;
  webhookMethod: 'GET' | 'POST';
  webhookSecret: string;
  // Round-trip-only: no UI for rateLimit yet. PATCH replaces config
  // wholesale, so we stash + re-emit to avoid wiping an API-set value.
  webhookRateLimit?: number;
  scheduleCron: string;
  scheduleTimezone: string;
  scheduleTarget: ScheduleTarget;
  schedulePrompt: string;
  // PATCH replaces config wholesale, so schedule run parameters are
  // stashed here and emitted as config.triggerData on save.
  scheduleTriggerData?: Record<string, unknown>;
}

const DEFAULT_FORM: TriggerFormState = {
  name: '',
  enabled: true,
  type: 'schedule',
  workflowId: '',
  webhookPath: '',
  webhookMethod: 'POST',
  webhookSecret: '',
  scheduleCron: '',
  scheduleTimezone: 'UTC',
  scheduleTarget: 'orchestrator',
  schedulePrompt: '',
};

/* ─── Helpers ─── */

function isWebhookConfig(config: TriggerConfig): config is WebhookConfig {
  return config.type === 'webhook';
}

function isScheduleConfig(config: TriggerConfig): config is ScheduleConfig {
  return config.type === 'schedule';
}

function formFromTrigger(trigger: Trigger): TriggerFormState {
  const base = {
    name: trigger.name,
    enabled: trigger.enabled,
    workflowId: trigger.workflowId ?? '',
    webhookPath: '',
    webhookMethod: 'POST' as const,
    webhookSecret: '',
    scheduleCron: '',
    scheduleTimezone: 'UTC',
    scheduleTarget: 'workflow' as ScheduleTarget,
    schedulePrompt: '',
  };

  if (trigger.type === 'webhook' && isWebhookConfig(trigger.config)) {
    return {
      ...base,
      type: 'webhook',
      webhookPath: trigger.config.path,
      webhookMethod: trigger.config.method || 'POST',
      webhookSecret: trigger.config.secret || '',
      webhookRateLimit: trigger.config.rateLimit,
    };
  }

  if (trigger.type === 'schedule' && isScheduleConfig(trigger.config)) {
    return {
      ...base,
      type: 'schedule',
      scheduleCron: trigger.config.cron,
      scheduleTimezone: trigger.config.timezone || 'UTC',
      scheduleTarget: trigger.config.target || 'workflow',
      schedulePrompt: trigger.config.prompt || '',
      scheduleTriggerData: trigger.config.triggerData,
    };
  }

  return { ...base, type: 'manual' };
}

function toConfig(form: TriggerFormState): TriggerConfig {
  if (form.type === 'webhook') {
    return {
      type: 'webhook',
      path: form.webhookPath.trim(),
      method: form.webhookMethod,
      ...(form.webhookSecret.trim() ? { secret: form.webhookSecret.trim() } : {}),
      // Round-trip an API-set rateLimit so editing the trigger doesn't
      // silently wipe it.
      ...(typeof form.webhookRateLimit === 'number' ? { rateLimit: form.webhookRateLimit } : {}),
    };
  }

  if (form.type === 'schedule') {
    return {
      type: 'schedule',
      cron: form.scheduleCron.trim(),
      timezone: form.scheduleTimezone.trim() || undefined,
      target: form.scheduleTarget,
      prompt: form.scheduleTarget === 'orchestrator' ? form.schedulePrompt.trim() : undefined,
      // Static trigger payload for every scheduled workflow run.
      ...(form.scheduleTriggerData && Object.keys(form.scheduleTriggerData).length > 0
        ? { triggerData: form.scheduleTriggerData }
        : {}),
    };
  }

  return { type: 'manual' };
}

function getFormTarget(form: TriggerFormState): ScheduleTarget {
  return form.type === 'schedule' ? form.scheduleTarget : 'workflow';
}

function canSelectOrchestratorTarget(type: TriggerType): boolean {
  return type === 'schedule';
}

function shouldIncludeWorkflowId(form: TriggerFormState): boolean {
  return getFormTarget(form) === 'workflow';
}

function shouldEditScheduleInputs(form: TriggerFormState): boolean {
  return form.type === 'schedule' && getFormTarget(form) === 'workflow' && Boolean(form.workflowId);
}

function validateForm(form: TriggerFormState): string | null {
  if (!form.name.trim()) return 'Trigger name is required.';
  if (form.type === 'webhook' && !form.webhookPath.trim()) return 'Webhook path is required.';
  if (form.type === 'webhook' && !form.workflowId) return 'Webhook triggers must be linked to a workflow.';
  if (form.type === 'manual' && !form.workflowId) return 'Manual triggers must be linked to a workflow.';
  if (form.type === 'schedule' && !form.scheduleCron.trim()) return 'Cron expression is required.';
  if (form.type === 'schedule' && form.scheduleTarget === 'workflow' && !form.workflowId) {
    return 'Workflow schedule triggers must be linked to a workflow.';
  }
  if (form.type === 'schedule' && form.scheduleTarget === 'orchestrator' && !form.schedulePrompt.trim()) {
    return 'Prompt is required for orchestrator schedule triggers.';
  }
  return null;
}

function describeTrigger(trigger: Trigger): string {
  if (trigger.type === 'manual') return 'Manual run only';
  if (trigger.type === 'webhook' && isWebhookConfig(trigger.config)) {
    const method = trigger.config.method || 'POST';
    return `${method} /api/triggers/${trigger.id}/webhook`;
  }
  if (trigger.type === 'schedule' && isScheduleConfig(trigger.config)) {
    const target = trigger.config.target || 'workflow';
    return `${trigger.config.cron} · ${trigger.config.timezone || 'UTC'} · ${target}`;
  }
  return trigger.type;
}

/* ─── Filter Options ─── */

const TYPE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'manual', label: 'Manual' },
] as const;

/* ═══════════════════════════════════════════════════════════
   TriggerList Component
   ═══════════════════════════════════════════════════════════ */

export function TriggerList() {
  const { data, isLoading, error } = useTriggers();
  const { data: workflowsData } = useWorkflows();
  const createTrigger = useCreateTrigger();
  const updateTrigger = useUpdateTrigger();
  const deleteTrigger = useDeleteTrigger();
  const runTrigger = useRunTrigger();
  const enableTrigger = useEnableTrigger();
  const disableTrigger = useDisableTrigger();

  const [search, setSearch] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState<string>('all');
  const [open, setOpen] = React.useState(false);
  const [editingTrigger, setEditingTrigger] = React.useState<Trigger | null>(null);
  const [form, setForm] = React.useState<TriggerFormState>(DEFAULT_FORM);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [scheduleInputFields, setScheduleInputFields] = React.useState<Record<string, ManualWorkflowInputField>>({});
  const [scheduleInputErrors, setScheduleInputErrors] = React.useState<Record<string, string>>({});
  const [manualTrigger, setManualTrigger] = React.useState<Trigger | null>(null);
  // Webhook-token reveal state. Populated from the create/PATCH response
  // when the server mints a token (new webhook trigger OR transition
  // from manual/schedule → webhook). The token is shown ONCE and then
  // discarded — the GET/PATCH endpoints never echo it.
  const [revealedToken, setRevealedToken] = React.useState<{
    token: string;
    webhookUrl?: string;
  } | null>(null);

  const triggers = data?.triggers ?? [];
  const workflows = workflowsData?.workflows ?? [];
  const manualWorkflowId = manualTrigger?.workflowId ?? '';
  const { data: manualDraftData, isLoading: manualDraftLoading } = useWorkflowDraft(manualWorkflowId);
  const scheduleWorkflowId = open && shouldEditScheduleInputs(form) ? form.workflowId : '';
  const { data: scheduleDraftData, isLoading: scheduleDraftLoading } = useWorkflowDraft(scheduleWorkflowId);
  const scheduleInputFieldList = React.useMemo(
    () => Object.values(scheduleInputFields),
    [scheduleInputFields],
  );

  React.useEffect(() => {
    if (!open || !shouldEditScheduleInputs(form)) {
      setScheduleInputFields({});
      setScheduleInputErrors({});
      return;
    }

    const triggerNode = scheduleDraftData?.draft?.nodes.find((node) => node.type === 'trigger');
    setScheduleInputFields(createWorkflowInputFields(triggerNode?.dataSchema, form.scheduleTriggerData));
    setScheduleInputErrors({});
  }, [
    form.scheduleTriggerData,
    form.scheduleTarget,
    form.type,
    form.workflowId,
    open,
    scheduleDraftData?.draft,
  ]);

  const filtered = React.useMemo(() => {
    let result = triggers;
    if (typeFilter !== 'all') {
      result = result.filter((t) => t.type === typeFilter);
    }
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(lower) ||
          (t.workflowName && t.workflowName.toLowerCase().includes(lower))
      );
    }
    return result;
  }, [triggers, typeFilter, search]);

  const resetForm = React.useCallback(() => {
    setForm(DEFAULT_FORM);
    setFormError(null);
    setScheduleInputFields({});
    setScheduleInputErrors({});
    setEditingTrigger(null);
  }, []);

  const openCreateDialog = () => {
    resetForm();
    setOpen(true);
  };

  const openEditDialog = (trigger: Trigger) => {
    setForm(formFromTrigger(trigger));
    setFormError(null);
    setEditingTrigger(trigger);
    setOpen(true);
  };

  const onField = <K extends keyof TriggerFormState>(field: K, value: TriggerFormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFormError(null);
  };

  const onTypeChange = (type: TriggerType) => {
    setForm((prev) => ({
      ...prev,
      type,
      scheduleTarget: canSelectOrchestratorTarget(type) ? prev.scheduleTarget : 'workflow',
    }));
    setFormError(null);
  };

  const onTargetChange = (target: ScheduleTarget) => {
    setForm((prev) => ({ ...prev, scheduleTarget: target }));
    setFormError(null);
  };

  const onScheduleInputChange = (name: string, value: string | boolean) => {
    setScheduleInputFields((current) => ({
      ...current,
      [name]: {
        ...current[name]!,
        value,
      },
    }));
    setScheduleInputErrors((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const onSave = async (event: React.FormEvent) => {
    event.preventDefault();
    const validationError = validateForm(form);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    try {
      let formForSave = form;
      if (shouldEditScheduleInputs(form)) {
        if (scheduleDraftLoading) {
          setFormError('Workflow parameters are still loading.');
          return;
        }

        const parsedInputs = parseWorkflowInputFields(scheduleInputFields);
        if (!parsedInputs.ok) {
          setScheduleInputErrors(parsedInputs.fieldErrors);
          return;
        }
        formForSave = { ...form, scheduleTriggerData: parsedInputs.inputs };
      }

      const payload: CreateTriggerRequest = {
        name: formForSave.name.trim(),
        enabled: formForSave.enabled,
        config: toConfig(formForSave),
        ...(shouldIncludeWorkflowId(formForSave) && formForSave.workflowId ? { workflowId: formForSave.workflowId } : {}),
      };

      if (editingTrigger) {
        const result = await updateTrigger.mutateAsync({
          triggerId: editingTrigger.id,
          data: {
            ...payload,
            workflowId: shouldIncludeWorkflowId(formForSave) ? formForSave.workflowId || null : null,
          },
        });
        toastSuccess('Trigger updated', `${formForSave.name.trim()} was updated.`);
        if (result.webhookToken) {
          // Server minted a fresh token because PATCH transitioned the
          // trigger to webhook. Show the reveal dialog INSTEAD of closing
          // — the user needs to capture it before navigating away.
          setRevealedToken({
            token: result.webhookToken,
            ...(result.webhookUrl ? { webhookUrl: result.webhookUrl } : {}),
          });
          setOpen(false);
          resetForm();
          return;
        }
      } else {
        const result = await createTrigger.mutateAsync(payload);
        toastSuccess('Trigger created', `${formForSave.name.trim()} was created.`);
        if (result.webhookToken) {
          setRevealedToken({
            token: result.webhookToken,
            ...(result.webhookUrl ? { webhookUrl: result.webhookUrl } : {}),
          });
          setOpen(false);
          resetForm();
          return;
        }
      }

      setOpen(false);
      resetForm();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save trigger.';
      setFormError(message);
      toastError('Failed to save trigger', message);
    }
  };

  const onDelete = async (trigger: Trigger) => {
    const confirmed = window.confirm(`Delete trigger "${trigger.name}"?`);
    if (!confirmed) return;
    try {
      await deleteTrigger.mutateAsync(trigger.id);
      toastSuccess('Trigger deleted', `${trigger.name} was removed.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      toastError('Failed to delete trigger', message);
    }
  };

  const runTriggerDirectly = async (trigger: Trigger) => {
    try {
      const result = await runTrigger.mutateAsync({ triggerId: trigger.id });
      toastSuccess('Trigger dispatched', result.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Run failed';
      toastError('Failed to run trigger', message);
    }
  };

  const onRun = (trigger: Trigger) => {
    if (trigger.workflowId) {
      setManualTrigger(trigger);
      return;
    }
    void runTriggerDirectly(trigger);
  };

  const onRunManualTrigger = async (payload: ManualWorkflowPayload) => {
    if (!manualTrigger) return;
    try {
      const result = await runTrigger.mutateAsync({
        triggerId: manualTrigger.id,
        triggerData: payload.triggerData,
      });
      setManualTrigger(null);
      toastSuccess('Trigger dispatched', result.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Run failed';
      toastError('Failed to run trigger', message);
    }
  };

  const onToggleEnabled = async (trigger: Trigger) => {
    try {
      if (trigger.enabled) {
        await disableTrigger.mutateAsync(trigger.id);
        toastSuccess('Trigger disabled', `${trigger.name} is now off.`);
      } else {
        await enableTrigger.mutateAsync(trigger.id);
        toastSuccess('Trigger enabled', `${trigger.name} is now on.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      toastError('Failed to update trigger', message);
    }
  };

  const busy =
    createTrigger.isPending ||
    updateTrigger.isPending ||
    deleteTrigger.isPending ||
    runTrigger.isPending ||
    enableTrigger.isPending ||
    disableTrigger.isPending;

  if (isLoading) {
    return <TriggerListSkeleton />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
        <p className="text-sm text-pretty text-red-600 dark:text-red-400">
          Failed to load triggers. Please try again.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ManualWorkflowDialog
        open={Boolean(manualTrigger)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setManualTrigger(null);
        }}
        definition={manualDraftData?.draft ?? null}
        workflowName={manualTrigger?.workflowName}
        isLoadingDefinition={Boolean(manualTrigger?.workflowId) && manualDraftLoading}
        isSubmitting={runTrigger.isPending}
        onSubmit={onRunManualTrigger}
      />

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="w-full sm:w-64">
            <SearchInput value={search} onChange={setSearch} placeholder="Search triggers..." />
          </div>
          <div className="flex gap-1">
            {TYPE_FILTERS.map((option) => (
              <button
                key={option.value}
                onClick={() => setTypeFilter(option.value)}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  typeFilter === option.value
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <Button size="sm" onClick={openCreateDialog}>
          Create Trigger
        </Button>
      </div>

      {/* Trigger List */}
      {triggers.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-700">
            <TriggerIcon className="size-6 text-neutral-400" />
          </div>
          <h3 className="text-sm font-medium text-balance text-neutral-900 dark:text-neutral-100">
            No triggers yet
          </h3>
          <p className="mt-1 text-sm text-pretty text-neutral-500 dark:text-neutral-400">
            Create a trigger to automate workflow runs or schedule orchestrator prompts.
          </p>
          <Button size="sm" className="mt-4" onClick={openCreateDialog}>
            Create Trigger
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
          <p className="text-sm text-pretty text-neutral-500 dark:text-neutral-400">
            No triggers match your filters.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
                  Trigger
                </th>
                <th className="hidden px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400 sm:table-cell">
                  Type
                </th>
                <th className="hidden px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400 md:table-cell">
                  Target
                </th>
                <th className="hidden px-4 py-3 text-left text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400 lg:table-cell">
                  Last Run
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-700">
              {filtered.map((trigger) => {
                const schedulePrompt =
                  trigger.type === 'schedule' && isScheduleConfig(trigger.config) && trigger.config.target === 'orchestrator'
                    ? trigger.config.prompt
                    : null;

                return (
                  <tr key={trigger.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800">
                          <TriggerTypeIcon type={trigger.type} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                              {trigger.name}
                            </p>
                            <Badge variant={trigger.enabled ? 'success' : 'secondary'} className="text-xs">
                              {trigger.enabled ? 'On' : 'Off'}
                            </Badge>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                            {describeTrigger(trigger)}
                          </p>
                          {schedulePrompt && (
                            <p className="mt-0.5 line-clamp-1 text-xs text-neutral-400 dark:text-neutral-500">
                              Prompt: {schedulePrompt}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <Badge variant="default" className="text-xs">
                        {trigger.type}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      {trigger.workflowId ? (
                        <Link
                          to="/automation/workflows/$workflowId"
                          params={{ workflowId: trigger.workflowId }}
                          search={{ tab: 'triggers' }}
                          className="text-sm text-accent hover:underline"
                        >
                          {trigger.workflowName || trigger.workflowId.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="text-xs text-neutral-400 dark:text-neutral-500">
                          Orchestrator
                        </span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      <span className="text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
                        {trigger.lastRunAt ? formatRelativeTime(trigger.lastRunAt) : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => onRun(trigger)} disabled={busy}>
                          <PlayIcon className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onToggleEnabled(trigger)} disabled={busy}>
                          {trigger.enabled ? <PauseIcon className="size-3.5" /> : <PlayCircleIcon className="size-3.5" />}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openEditDialog(trigger)} disabled={busy}>
                          <EditIcon className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onDelete(trigger)} disabled={busy} className="text-red-500 hover:text-red-600">
                          <TrashIcon className="size-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) resetForm();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <form onSubmit={onSave}>
            <DialogHeader>
              <DialogTitle>{editingTrigger ? 'Edit Trigger' : 'Create Trigger'}</DialogTitle>
              <DialogDescription>
                Choose how this trigger starts, then choose what it runs.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Name
                </label>
                <Input
                  value={form.name}
                  onChange={(e) => onField('name', e.target.value)}
                  placeholder="Nightly triage"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Type
                  </label>
                  <select
                    value={form.type}
                    onChange={(e) => onTypeChange(e.target.value as TriggerType)}
                    className="h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-100"
                  >
                    <option value="manual">Manual</option>
                    <option value="webhook">Webhook</option>
                    <option value="schedule">Schedule</option>
                  </select>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {form.type === 'manual' && 'Run on demand from Valet.'}
                    {form.type === 'webhook' && 'Run when an external request arrives.'}
                    {form.type === 'schedule' && 'Run from a cron schedule.'}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Target
                  </label>
                  <select
                    value={getFormTarget(form)}
                    onChange={(e) => onTargetChange(e.target.value as ScheduleTarget)}
                    className="h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-100"
                  >
                    <option value="workflow">Run workflow</option>
                    {canSelectOrchestratorTarget(form.type) && (
                      <option value="orchestrator">Prompt orchestrator</option>
                    )}
                  </select>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {canSelectOrchestratorTarget(form.type)
                      ? 'Schedules can run workflows or prompt your orchestrator.'
                      : 'Manual and webhook triggers currently run workflows.'}
                  </p>
                </div>
              </div>

              {getFormTarget(form) === 'workflow' && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Workflow
                  </label>
                  <select
                    value={form.workflowId}
                    onChange={(e) => onField('workflowId', e.target.value)}
                    className="h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-100"
                  >
                    <option value="">Select a workflow...</option>
                    {workflows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Webhook fields */}
              {form.type === 'webhook' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      Webhook Path
                    </label>
                    <Input
                      value={form.webhookPath}
                      onChange={(e) => onField('webhookPath', e.target.value)}
                      placeholder="incoming/my-trigger"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      Method
                    </label>
                    <select
                      value={form.webhookMethod}
                      onChange={(e) => onField('webhookMethod', e.target.value as 'GET' | 'POST')}
                      className="h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-100"
                    >
                      <option value="POST">POST</option>
                      <option value="GET">GET</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      Secret (optional)
                    </label>
                    <Input
                      value={form.webhookSecret}
                      onChange={(e) => onField('webhookSecret', e.target.value)}
                      placeholder="secret key"
                    />
                  </div>
                </div>
              )}

              {/* Schedule fields */}
              {form.type === 'schedule' && (
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                        Cron Expression
                      </label>
                      <Input
                        value={form.scheduleCron}
                        onChange={(e) => onField('scheduleCron', e.target.value)}
                        placeholder="0 9 * * 1-5"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                        Timezone
                      </label>
                      <Input
                        value={form.scheduleTimezone}
                        onChange={(e) => onField('scheduleTimezone', e.target.value)}
                        placeholder="America/Los_Angeles"
                      />
                    </div>
                  </div>
                  {shouldEditScheduleInputs(form) && (
                    <ScheduledWorkflowInputs
                      fields={scheduleInputFieldList}
                      fieldErrors={scheduleInputErrors}
                      isLoading={scheduleDraftLoading}
                      onChange={onScheduleInputChange}
                    />
                  )}
                  {getFormTarget(form) === 'orchestrator' && (
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                        Orchestrator Prompt
                      </label>
                      <textarea
                        value={form.schedulePrompt}
                        onChange={(e) => onField('schedulePrompt', e.target.value)}
                        rows={4}
                        placeholder="Summarize open tasks and create a plan for today."
                        className={cn(
                          'w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-neutral-100',
                          formError && 'border-red-500'
                        )}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Enabled toggle */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.enabled}
                  onClick={() => onField('enabled', !form.enabled)}
                  className={cn(
                    'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                    form.enabled ? 'bg-neutral-900 dark:bg-neutral-100' : 'bg-neutral-200 dark:bg-neutral-700'
                  )}
                >
                  <span
                    className={cn(
                      'pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform dark:bg-neutral-900',
                      form.enabled ? 'translate-x-5' : 'translate-x-0'
                    )}
                  />
                </button>
                <span className="text-sm text-neutral-700 dark:text-neutral-300">
                  {form.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>

              {/* Error */}
              {formError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                  {formError}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving...' : editingTrigger ? 'Save Trigger' : 'Create Trigger'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <WebhookTokenReveal
        token={revealedToken?.token ?? null}
        {...(revealedToken?.webhookUrl ? { webhookUrl: revealedToken.webhookUrl } : {})}
        onClose={() => setRevealedToken(null)}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   Icons
   ═══════════════════════════════════════════════════════════ */

function TriggerIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function TriggerTypeIcon({ type }: { type: string }) {
  const iconClass = 'size-4 text-neutral-400';

  if (type === 'webhook') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={iconClass}>
        <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
        <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
        <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
      </svg>
    );
  }

  if (type === 'schedule') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={iconClass}>
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    );
  }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={iconClass}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function PlayCircleIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="10 8 16 12 10 16 10 8" />
    </svg>
  );
}

function EditIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

/* ─── Skeleton ─── */

function TriggerListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800">
        <div className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-4">
              <Skeleton className="size-8 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
