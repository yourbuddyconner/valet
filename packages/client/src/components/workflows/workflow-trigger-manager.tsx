import * as React from 'react';
import {
  type Trigger,
  type TriggerConfig,
  type WebhookConfig,
  type ScheduleConfig,
  useCreateTrigger,
  useDeleteTrigger,
  useDisableTrigger,
  useEnableTrigger,
  useRunTrigger,
  useUpdateTrigger,
} from '@/api/triggers';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { cn } from '@/lib/cn';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';
import { WebhookTokenReveal } from '@/components/automation/webhook-token-reveal';

interface WorkflowTriggerManagerProps {
  workflowId: string;
  triggers: Trigger[];
}

type TriggerType = 'manual' | 'webhook' | 'schedule';
type ScheduleTarget = 'workflow' | 'orchestrator';

interface TriggerFormState {
  name: string;
  enabled: boolean;
  type: TriggerType;
  webhookPath: string;
  webhookMethod: 'GET' | 'POST';
  webhookSecret: string;
  // Round-trip-only: no UI for editing rateLimit yet. PATCH replaces
  // config wholesale, so stash + re-emit to avoid wiping an API-set
  // override.
  webhookRateLimit?: number;
  scheduleCron: string;
  scheduleTimezone: string;
  scheduleTarget: ScheduleTarget;
  schedulePrompt: string;
  // Round-trip-only: the form has no UI for editing schedule inputs yet,
  // but PATCH replaces config wholesale, so we stash and re-emit them on
  // save to avoid erasing inputs that were set via the API.
  scheduleInputs?: Record<string, unknown>;
}

const DEFAULT_FORM: TriggerFormState = {
  name: '',
  enabled: true,
  type: 'manual',
  webhookPath: '',
  webhookMethod: 'POST',
  webhookSecret: '',
  scheduleCron: '',
  scheduleTimezone: 'UTC',
  scheduleTarget: 'workflow',
  schedulePrompt: '',
};

function isWebhookConfig(config: TriggerConfig): config is WebhookConfig {
  return config.type === 'webhook';
}

function isScheduleConfig(config: TriggerConfig): config is ScheduleConfig {
  return config.type === 'schedule';
}

function formFromTrigger(trigger: Trigger): TriggerFormState {
  if (trigger.type === 'webhook' && isWebhookConfig(trigger.config)) {
    return {
      name: trigger.name,
      enabled: trigger.enabled,
      type: 'webhook',
      webhookPath: trigger.config.path,
      webhookMethod: trigger.config.method || 'POST',
      webhookSecret: trigger.config.secret || '',
      webhookRateLimit: trigger.config.rateLimit,
      scheduleCron: '',
      scheduleTimezone: 'UTC',
      scheduleTarget: 'workflow',
      schedulePrompt: '',
    };
  }

  if (trigger.type === 'schedule' && isScheduleConfig(trigger.config)) {
    return {
      name: trigger.name,
      enabled: trigger.enabled,
      type: 'schedule',
      webhookPath: '',
      webhookMethod: 'POST',
      webhookSecret: '',
      scheduleCron: trigger.config.cron,
      scheduleTimezone: trigger.config.timezone || 'UTC',
      scheduleTarget: trigger.config.target || 'workflow',
      schedulePrompt: trigger.config.prompt || '',
      scheduleInputs: trigger.config.inputs,
    };
  }

  return {
    ...DEFAULT_FORM,
    name: trigger.name,
    enabled: trigger.enabled,
    type: 'manual',
  };
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
      // PATCH replaces config wholesale; preserve any inputs the trigger
      // was created with so an edit doesn't silently erase them.
      ...(form.scheduleInputs && Object.keys(form.scheduleInputs).length > 0
        ? { inputs: form.scheduleInputs }
        : {}),
    };
  }

  return { type: 'manual' };
}

function validateForm(form: TriggerFormState): string | null {
  if (!form.name.trim()) return 'Trigger name is required.';
  if (form.type === 'webhook' && !form.webhookPath.trim()) return 'Webhook path is required.';
  if (form.type === 'schedule' && !form.scheduleCron.trim()) return 'Cron expression is required.';
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
    return `${trigger.config.cron} • ${trigger.config.timezone || 'UTC'} • ${target}`;
  }
  return trigger.type;
}

export function WorkflowTriggerManager({ workflowId, triggers }: WorkflowTriggerManagerProps) {
  const createTrigger = useCreateTrigger();
  const updateTrigger = useUpdateTrigger();
  const deleteTrigger = useDeleteTrigger();
  const runTrigger = useRunTrigger();
  const enableTrigger = useEnableTrigger();
  const disableTrigger = useDisableTrigger();

  const [open, setOpen] = React.useState(false);
  const [editingTrigger, setEditingTrigger] = React.useState<Trigger | null>(null);
  const [form, setForm] = React.useState<TriggerFormState>(DEFAULT_FORM);
  const [formError, setFormError] = React.useState<string | null>(null);
  // Webhook-token reveal. The server returns the token EXACTLY ONCE
  // (on create OR on PATCH that transitions manual/schedule → webhook).
  // If the UI drops it, the webhook URL returns 401 forever and the
  // only recovery is to recreate the trigger.
  const [revealedToken, setRevealedToken] = React.useState<{
    token: string;
    webhookUrl?: string;
  } | null>(null);

  const resetForm = React.useCallback(() => {
    setForm(DEFAULT_FORM);
    setFormError(null);
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

  const onSave = async (event: React.FormEvent) => {
    event.preventDefault();
    const validationError = validateForm(form);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    try {
      const payload = {
        workflowId,
        name: form.name.trim(),
        enabled: form.enabled,
        config: toConfig(form),
      };

      if (editingTrigger) {
        const result = await updateTrigger.mutateAsync({
          triggerId: editingTrigger.id,
          data: payload,
        });
        toastSuccess('Trigger updated', `${form.name.trim()} was updated.`);
        if (result.webhookToken) {
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
        toastSuccess('Trigger created', `${form.name.trim()} was created.`);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save trigger.';
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Delete failed';
      toastError('Failed to delete trigger', message);
    }
  };

  const onRun = async (trigger: Trigger) => {
    try {
      const result = await runTrigger.mutateAsync({ triggerId: trigger.id });
      toastSuccess('Trigger dispatched', result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Run failed';
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Update failed';
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

  return (
    <Card className="overflow-hidden border-neutral-200/80 dark:border-neutral-700/80">
      <CardHeader className="border-b border-neutral-100 bg-gradient-to-r from-neutral-50 to-cyan-50/60 dark:border-neutral-800 dark:from-neutral-900 dark:to-neutral-900">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg">Triggers</CardTitle>
            <CardDescription>Manage manual, webhook, and schedule launch points for this workflow.</CardDescription>
          </div>
          <Button size="sm" variant="secondary" onClick={openCreateDialog}>
            Add Trigger
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-4 sm:p-5">
        {triggers.length > 0 ? (
          <div className="space-y-2.5">
            {triggers.map((trigger) => {
              const schedulePrompt =
                trigger.type === 'schedule' && isScheduleConfig(trigger.config) && trigger.config.target === 'orchestrator'
                  ? trigger.config.prompt
                  : null;

              return (
                <div
                  key={trigger.id}
                  className="rounded-xl border border-neutral-200 bg-white/80 p-3 dark:border-neutral-700 dark:bg-neutral-900/80"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800">
                          <TriggerTypeIcon type={trigger.type} />
                        </div>
                        <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          {trigger.name}
                        </p>
                        <Badge variant={trigger.enabled ? 'success' : 'secondary'} className="text-xs">
                          {trigger.enabled ? 'On' : 'Off'}
                        </Badge>
                        <Badge variant="default" className="text-xs">
                          {trigger.type}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{describeTrigger(trigger)}</p>
                      {schedulePrompt && (
                        <p className="mt-1 line-clamp-2 text-xs text-neutral-500 dark:text-neutral-400">
                          Prompt: {schedulePrompt}
                        </p>
                      )}
                      <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
                        Updated {formatRelativeTime(trigger.updatedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => onRun(trigger)} disabled={busy}>
                        Run
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => onToggleEnabled(trigger)} disabled={busy}>
                        {trigger.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => openEditDialog(trigger)} disabled={busy}>
                        Edit
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => onDelete(trigger)} disabled={busy}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-pretty text-neutral-500 dark:text-neutral-400">
            No triggers configured yet. Add one to automate workflow or orchestrator actions.
          </p>
        )}
      </CardContent>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) resetForm();
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <form onSubmit={onSave}>
            <DialogHeader>
              <DialogTitle>{editingTrigger ? 'Edit Trigger' : 'Create Trigger'}</DialogTitle>
              <DialogDescription>
                Configure trigger type and behavior. Schedule triggers can run this workflow or prompt your orchestrator.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="grid gap-4 sm:grid-cols-2">
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
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Type
                  </label>
                  <select
                    value={form.type}
                    onChange={(e) => onField('type', e.target.value as TriggerType)}
                    className="h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-100"
                  >
                    <option value="manual">Manual</option>
                    <option value="webhook">Webhook</option>
                    <option value="schedule">Schedule</option>
                  </select>
                </div>
              </div>

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

              {form.type === 'schedule' && (
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                        Cron
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
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      Schedule Target
                    </label>
                    <select
                      value={form.scheduleTarget}
                      onChange={(e) => onField('scheduleTarget', e.target.value as ScheduleTarget)}
                      className="h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-100"
                    >
                      <option value="workflow">Run workflow</option>
                      <option value="orchestrator">Prompt orchestrator</option>
                    </select>
                  </div>
                  {form.scheduleTarget === 'orchestrator' && (
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
    </Card>
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
