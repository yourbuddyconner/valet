import * as React from 'react';
import type { WorkflowDefinition } from '@valet/shared';
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
import {
  createManualWorkflowForm,
  parseManualWorkflowSubmission,
  type ManualWorkflowForm,
  type ManualWorkflowInputField,
} from './manual-workflow-dialog-model';

export interface ManualWorkflowPayload {
  triggerData: Record<string, unknown>;
  inputs: Record<string, unknown>;
}

interface ManualWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  definition: WorkflowDefinition | null;
  workflowName?: string | null;
  isLoadingDefinition?: boolean;
  isSubmitting?: boolean;
  onSubmit: (payload: ManualWorkflowPayload) => void;
}

export function ManualWorkflowDialog({
  open,
  onOpenChange,
  definition,
  workflowName,
  isLoadingDefinition = false,
  isSubmitting = false,
  onSubmit,
}: ManualWorkflowDialogProps) {
  const [form, setForm] = React.useState<ManualWorkflowForm>(() => createManualWorkflowForm(definition));
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(createManualWorkflowForm(definition));
    setFieldErrors({});
  }, [definition, open]);

  const triggerDataFields = React.useMemo(() => Object.values(form.triggerDataFields), [form.triggerDataFields]);
  const hasTriggerDataFields = triggerDataFields.length > 0;
  const inputFields = React.useMemo(() => Object.values(form.inputs), [form.inputs]);
  const hasInputs = inputFields.length > 0;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseManualWorkflowSubmission(form);
    if (!parsed.ok) {
      setFieldErrors(parsed.fieldErrors);
      return;
    }
    setFieldErrors({});
    onSubmit({ triggerData: parsed.triggerData, inputs: parsed.inputs });
  }

  function updateTriggerDataText(value: string) {
    setForm((current) => ({ ...current, triggerDataText: value }));
    setFieldErrors((current) => omitKey(current, 'triggerData'));
  }

  function updateTriggerDataFieldValue(name: string, value: string | boolean) {
    setForm((current) => ({
      ...current,
      triggerDataFields: {
        ...current.triggerDataFields,
        [name]: {
          ...current.triggerDataFields[name]!,
          value,
        },
      },
    }));
    setFieldErrors((current) => omitKey(current, `triggerData.${name}`));
  }

  function updateInputValue(name: string, value: string | boolean) {
    setForm((current) => ({
      ...current,
      inputs: {
        ...current.inputs,
        [name]: {
          ...current.inputs[name]!,
          value,
        },
      },
    }));
    setFieldErrors((current) => omitKey(current, name));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden p-0 sm:max-w-2xl">
        <form onSubmit={handleSubmit} className="flex max-h-[85vh] flex-col">
          <DialogHeader className="border-b border-neutral-200 px-6 py-5 dark:border-neutral-800">
            <DialogTitle>Run workflow manually</DialogTitle>
            <DialogDescription>
              {workflowName
                ? `Provide test data for ${workflowName}.`
                : 'Provide test data for this workflow.'}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-auto px-6 py-5">
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  Trigger data
                </h3>
                <span className="font-mono text-xs text-neutral-500">trigger.data</span>
              </div>
              {hasTriggerDataFields ? (
                <div className="space-y-3">
                  {triggerDataFields.map((field) => (
                    <ManualWorkflowInputControl
                      key={field.name}
                      field={field}
                      error={fieldErrors[`triggerData.${field.name}`]}
                      onChange={(value) => updateTriggerDataFieldValue(field.name, value)}
                    />
                  ))}
                </div>
              ) : (
                <>
                  <textarea
                    id="manual-trigger-data"
                    value={form.triggerDataText}
                    onChange={(event) => updateTriggerDataText(event.target.value)}
                    rows={7}
                    spellCheck={false}
                    className={cn(
                      'w-full resize-y rounded-md border bg-white px-3 py-2 font-mono text-sm text-neutral-900',
                      'focus:outline-none focus:ring-2 focus:ring-neutral-400',
                      'dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-neutral-600',
                      fieldErrors.triggerData
                        ? 'border-red-300 dark:border-red-700'
                        : 'border-neutral-200 dark:border-neutral-700',
                    )}
                  />
                  {fieldErrors.triggerData ? (
                    <p className="text-sm text-red-600 dark:text-red-400">{fieldErrors.triggerData}</p>
                  ) : (
                    <p className="text-xs text-neutral-500">
                      This becomes available as <span className="font-mono">{'{{trigger.data}}'}</span>.
                    </p>
                  )}
                </>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                    Workflow inputs
                  </h3>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Declared inputs are available as <span className="font-mono">{'{{inputs.name}}'}</span>.
                  </p>
                </div>
              </div>

              {isLoadingDefinition ? (
                <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
                  Loading workflow inputs...
                </div>
              ) : hasInputs ? (
                <div className="space-y-3">
                  {inputFields.map((field) => (
                    <ManualWorkflowInputControl
                      key={field.name}
                      field={field}
                      error={fieldErrors[field.name]}
                      onChange={(value) => updateInputValue(field.name, value)}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
                  No declared workflow inputs.
                </div>
              )}
            </section>
          </div>

          <DialogFooter className="border-t border-neutral-200 px-6 py-4 dark:border-neutral-800">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || isLoadingDefinition}>
              {isSubmitting ? 'Starting...' : 'Start test run'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ManualWorkflowInputControl({
  field,
  error,
  onChange,
}: {
  field: ManualWorkflowInputField;
  error?: string;
  onChange: (value: string | boolean) => void;
}) {
  const label = (
    <div className="mb-1.5 flex items-center justify-between gap-3">
      <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {field.name}
        {field.spec.required ? <span className="ml-1 text-red-500">*</span> : null}
      </label>
      <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] uppercase text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
        {field.spec.type}
      </span>
    </div>
  );

  return (
    <div>
      {label}
      {field.spec.description ? (
        <p className="mb-1.5 text-xs text-neutral-500">{field.spec.description}</p>
      ) : null}
      {renderInputControl(field, onChange, Boolean(error))}
      {error ? <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}

function renderInputControl(
  field: ManualWorkflowInputField,
  onChange: (value: string | boolean) => void,
  hasError: boolean,
) {
  const baseClassName = cn(
    hasError && 'border-red-300 focus-visible:ring-red-300 dark:border-red-700 dark:focus-visible:ring-red-700',
  );

  if (field.spec.enum && canRenderEnumSelect(field.spec.enum)) {
    return (
      <select
        value={String(field.value)}
        onChange={(event) => onChange(coerceSelectValue(event.target.value, field.spec.type))}
        className={cn(
          'h-9 w-full rounded-md border bg-white px-3 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-400 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-600',
          hasError ? 'border-red-300 dark:border-red-700' : 'border-neutral-200 dark:border-neutral-700',
        )}
      >
        {field.spec.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  }

  if (field.spec.type === 'boolean') {
    return (
      <select
        value={field.value ? 'true' : 'false'}
        onChange={(event) => onChange(event.target.value === 'true')}
        className={cn(
          'h-9 w-full rounded-md border bg-white px-3 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-400 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-600',
          hasError ? 'border-red-300 dark:border-red-700' : 'border-neutral-200 dark:border-neutral-700',
        )}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (field.spec.type === 'object' || field.spec.type === 'array') {
    return (
      <textarea
        value={String(field.value)}
        onChange={(event) => onChange(event.target.value)}
        rows={5}
        spellCheck={false}
        className={cn(
          'w-full resize-y rounded-md border bg-white px-3 py-2 font-mono text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-400 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-neutral-600',
          hasError ? 'border-red-300 dark:border-red-700' : 'border-neutral-200 dark:border-neutral-700',
        )}
      />
    );
  }

  return (
    <Input
      type={field.spec.type === 'number' ? 'number' : 'text'}
      value={String(field.value)}
      onChange={(event) => onChange(event.target.value)}
      className={baseClassName}
    />
  );
}

function canRenderEnumSelect(values: unknown[]): boolean {
  return values.every((value) => (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ));
}

function coerceSelectValue(value: string, type: ManualWorkflowInputField['spec']['type']): string | boolean {
  if (type === 'boolean') return value === 'true';
  return value;
}

function omitKey(source: Record<string, string>, key: string): Record<string, string> {
  const next = { ...source };
  delete next[key];
  return next;
}
