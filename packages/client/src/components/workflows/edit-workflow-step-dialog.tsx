import * as React from 'react';
import type { WorkflowStep, Workflow, WorkflowData } from '@/api/workflows';
import { useUpdateWorkflow } from '@/api/workflows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { StepBehaviorEditors, type StepFormData } from '@/components/workflows/step-behavior-editors';
import { cn } from '@/lib/cn';

const STEP_TYPES = [
  { value: 'agent', label: 'Agent', description: 'Delegates reasoning and decision-making to the orchestrator persona.' },
  { value: 'agent_message', label: 'Agent Message', description: 'Sends a message to the current workflow session agent.' },
  { value: 'tool', label: 'Tool', description: 'Executes deterministic tool calls such as bash, API, or repository actions.' },
  { value: 'conditional', label: 'Conditional', description: 'Branches execution path based on runtime state.' },
  { value: 'loop', label: 'Loop', description: 'Repeats a nested sequence until the loop condition is satisfied.' },
  { value: 'parallel', label: 'Parallel', description: 'Runs child steps concurrently for faster throughput.' },
  { value: 'subworkflow', label: 'Subworkflow', description: 'Calls into a reusable nested workflow module.' },
  { value: 'approval', label: 'Approval', description: 'Creates a checkpoint requiring human or policy approval.' },
] as const;

interface EditWorkflowStepDialogProps {
  workflow: Workflow;
  step: WorkflowStep;
  stepIndex: number;
  trigger?: React.ReactNode;
}

const inputLabelClassName = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300';
const selectClassName =
  'w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-accent/30 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100';

function stringifyJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON: ${message}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getStepTypeDefinition(type: WorkflowStep['type']) {
  return STEP_TYPES.find((item) => item.value === type) ?? STEP_TYPES[0];
}

export function EditWorkflowStepDialog({
  workflow,
  step,
  stepIndex,
  trigger,
}: EditWorkflowStepDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [formData, setFormData] = React.useState<StepFormData>({
    id: step.id,
    name: step.name,
    type: step.type,
    tool: step.tool || '',
    goal: step.type === 'agent_message' ? (step.content || step.goal || '') : (step.goal || ''),
    context: step.context || '',
    awaitResponse: step.await_response === true || step.awaitResponse === true,
    awaitTimeoutMs: String(step.await_timeout_ms ?? step.awaitTimeoutMs ?? ''),
    outputVariable: step.outputVariable || '',
    argumentsJson: stringifyJson(step.arguments),
    conditionJson: stringifyJson(step.condition),
    thenJson: stringifyJson(step.then),
    elseJson: stringifyJson(step.else),
    stepsJson: stringifyJson(step.steps),
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const updateWorkflow = useUpdateWorkflow();

  React.useEffect(() => {
    if (open) {
      setFormData({
        id: step.id,
        name: step.name,
        type: step.type,
        tool: step.tool || '',
        goal: step.type === 'agent_message' ? (step.content || step.goal || '') : (step.goal || ''),
        context: step.context || '',
        awaitResponse: step.await_response === true || step.awaitResponse === true,
        awaitTimeoutMs: String(step.await_timeout_ms ?? step.awaitTimeoutMs ?? ''),
        outputVariable: step.outputVariable || '',
        argumentsJson: stringifyJson(step.arguments),
        conditionJson: stringifyJson(step.condition),
        thenJson: stringifyJson(step.then),
        elseJson: stringifyJson(step.else),
        stepsJson: stringifyJson(step.steps),
      });
      setErrors({});
    }
  }, [open, step]);

  const handleChange = <K extends keyof StepFormData>(field: K, value: StepFormData[K]) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: '' }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const newErrors: Record<string, string> = {};
    if (!formData.id.trim()) {
      newErrors.id = 'Step ID is required';
    }
    if (!formData.name.trim()) {
      newErrors.name = 'Name is required';
    }
    if (formData.type === 'tool' && !formData.tool.trim()) {
      newErrors.tool = 'Tool name is required for tool steps';
    }
    if (formData.type === 'agent_message' && !formData.goal.trim()) {
      newErrors.goal = 'Message content is required for agent message steps';
    }
    let parsedAwaitTimeoutMs: number | undefined;
    if (formData.type === 'agent_message' && formData.awaitResponse && formData.awaitTimeoutMs.trim()) {
      const parsed = Number.parseInt(formData.awaitTimeoutMs, 10);
      if (!Number.isFinite(parsed) || parsed < 1000) {
        newErrors.awaitTimeoutMs = 'Await timeout must be an integer >= 1000 ms';
      } else {
        parsedAwaitTimeoutMs = parsed;
      }
    }

    let parsedArguments: Record<string, unknown> | undefined;
    if (formData.argumentsJson.trim()) {
      const parsed = parseJson(formData.argumentsJson);
      if (!parsed.ok) {
        newErrors.argumentsJson = parsed.error;
      } else if (!isRecord(parsed.value)) {
        newErrors.argumentsJson = 'Arguments must be a JSON object';
      } else {
        parsedArguments = parsed.value;
      }
    }

    let parsedCondition: unknown = undefined;
    if (formData.conditionJson.trim()) {
      const parsed = parseJson(formData.conditionJson);
      if (!parsed.ok) {
        newErrors.conditionJson = parsed.error;
      } else {
        parsedCondition = parsed.value;
      }
    }

    const parseStepArray = (
      raw: string,
      field: 'thenJson' | 'elseJson' | 'stepsJson',
      label: string,
    ): WorkflowStep[] | undefined => {
      if (!raw.trim()) return undefined;
      const parsed = parseJson(raw);
      if (!parsed.ok) {
        newErrors[field] = parsed.error;
        return undefined;
      }
      if (!Array.isArray(parsed.value)) {
        newErrors[field] = `${label} must be a JSON array`;
        return undefined;
      }
      return parsed.value as WorkflowStep[];
    };

    const parsedThen = parseStepArray(formData.thenJson, 'thenJson', 'Then branch');
    const parsedElse = parseStepArray(formData.elseJson, 'elseJson', 'Else branch');
    const parsedSteps = parseStepArray(formData.stepsJson, 'stepsJson', 'Nested steps');

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    const updatedStep: WorkflowStep = {
      ...step,
      id: formData.id.trim(),
      name: formData.name,
      type: formData.type as WorkflowStep['type'],
      tool: formData.tool || undefined,
      goal: formData.goal || undefined,
      context: formData.context || undefined,
      content: formData.type === 'agent_message' ? (formData.goal || undefined) : undefined,
      await_response: formData.type === 'agent_message' ? (formData.awaitResponse || undefined) : undefined,
      await_timeout_ms: formData.type === 'agent_message' ? parsedAwaitTimeoutMs : undefined,
      outputVariable: formData.outputVariable || undefined,
      arguments: parsedArguments,
      condition: parsedCondition,
      then: parsedThen,
      else: parsedElse,
      steps: parsedSteps,
    };

    const updatedSteps = [...(workflow.data.steps || [])];
    updatedSteps[stepIndex] = updatedStep;

    const updatedData: WorkflowData = {
      ...workflow.data,
      steps: updatedSteps,
    };

    try {
      await updateWorkflow.mutateAsync({
        workflowId: workflow.id,
        data: updatedData,
      });
      setOpen(false);
    } catch {
      // Error handled by mutation
    }
  };

  const stepType = getStepTypeDefinition(formData.type);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="rounded-md p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
            aria-label="Edit step"
          >
            <EditIcon className="size-4" />
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-hidden p-0 sm:max-w-3xl">
        <form onSubmit={handleSubmit} className="flex max-h-[92dvh] flex-col">
          <div className="border-b border-neutral-200 bg-gradient-to-r from-neutral-50 to-cyan-50/70 px-5 py-4 dark:border-neutral-700 dark:from-neutral-900 dark:to-neutral-900 sm:px-6">
            <DialogHeader className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>Edit Step</DialogTitle>
                <Badge variant="secondary">#{stepIndex + 1}</Badge>
                <Badge variant="default">{stepType.label}</Badge>
              </div>
              <DialogDescription>
                Tune this step’s behavior, branching, and outputs without changing workflow wiring.
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="space-y-5 overflow-y-auto p-5 sm:p-6">
            <SectionCard title="Identity" description="Define this step’s handle and orchestration role.">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="step-id" className={inputLabelClassName}>
                    Step ID
                  </label>
                  <Input
                    id="step-id"
                    value={formData.id}
                    onChange={(e) => handleChange('id', e.target.value)}
                    placeholder="check_environment"
                    className={cn(errors.id && 'border-red-500')}
                  />
                  <FieldError message={errors.id} />
                </div>

                <div>
                  <label htmlFor="step-name" className={inputLabelClassName}>
                    Name
                  </label>
                  <Input
                    id="step-name"
                    value={formData.name}
                    onChange={(e) => handleChange('name', e.target.value)}
                    placeholder="Step name"
                    className={cn(errors.name && 'border-red-500')}
                  />
                  <FieldError message={errors.name} />
                </div>
              </div>

              <div className="mt-4">
                <label htmlFor="step-type" className={inputLabelClassName}>
                  Type
                </label>
                <select
                  id="step-type"
                  value={formData.type}
                  onChange={(e) => handleChange('type', e.target.value as WorkflowStep['type'])}
                  className={selectClassName}
                >
                  {STEP_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
                <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    Type Behavior
                  </p>
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
                    {stepType.description}
                  </p>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Step Behavior" description="Configure runtime inputs, goals, and branch logic.">
              <StepBehaviorEditors
                formData={formData}
                errors={errors}
                onChange={handleChange}
              />
            </SectionCard>

            <SectionCard title="Output" description="Expose this step result for downstream references.">
              <div>
                <label htmlFor="step-output" className={inputLabelClassName}>
                  Output Variable
                </label>
                <Input
                  id="step-output"
                  value={formData.outputVariable}
                  onChange={(e) => handleChange('outputVariable', e.target.value)}
                  placeholder="result"
                />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  Store the step output in this variable for use in later steps.
                </p>
              </div>
            </SectionCard>
          </div>

          <DialogFooter className="border-t border-neutral-200 bg-neutral-50 px-5 py-4 dark:border-neutral-700 dark:bg-neutral-900 sm:px-6">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={updateWorkflow.isPending}>
              {updateWorkflow.isPending ? 'Saving...' : 'Save Step'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white/90 p-4 dark:border-neutral-700 dark:bg-neutral-900/70">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{description}</p>
      </div>
      {children}
    </section>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-sm text-red-600 dark:text-red-400">{message}</p>;
}

function EditIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}
