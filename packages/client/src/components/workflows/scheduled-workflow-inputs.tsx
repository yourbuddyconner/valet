import {
  ManualWorkflowInputControl,
} from '@/components/workflows/manual-workflow-dialog';
import type { ManualWorkflowInputField } from '@/components/workflows/manual-workflow-dialog-model';

interface ScheduledWorkflowInputsProps {
  fields: ManualWorkflowInputField[];
  fieldErrors: Record<string, string>;
  isLoading: boolean;
  onChange: (name: string, value: string | boolean) => void;
}

export function ScheduledWorkflowInputs({
  fields,
  fieldErrors,
  isLoading,
  onChange,
}: ScheduledWorkflowInputsProps) {
  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
      <div>
        <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          Workflow run parameters
        </h3>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          These values are used for every scheduled run and are available as{' '}
          <span className="font-mono">{'{{trigger.data.name}}'}</span>.
        </p>
      </div>

      {isLoading ? (
        <div className="rounded-md border border-neutral-200 bg-white p-3 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950">
          Loading workflow parameters...
        </div>
      ) : fields.length > 0 ? (
        <div className="space-y-3">
          {fields.map((field) => (
            <ManualWorkflowInputControl
              key={field.name}
              field={field}
              error={fieldErrors[field.name]}
              onChange={(value) => onChange(field.name, value)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-neutral-200 bg-white p-3 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950">
          No declared workflow parameters.
        </div>
      )}
    </section>
  );
}
