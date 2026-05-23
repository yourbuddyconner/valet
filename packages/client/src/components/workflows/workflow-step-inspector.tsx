import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { WorkflowData, WorkflowStep } from '@/api/workflows';
import { usePersonas } from '@/api/personas';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { inferScope, type Scope } from './scope-inferencer';
import { ScopePanel } from './scope-panel';
import { StepTypeIcon } from './step-icons';
import { TemplatedInput } from './templated-input';

interface Props {
  step: WorkflowStep;
  onChange: (patch: Partial<WorkflowStep>) => void;
  workflow: WorkflowData;
}

const TYPE_LABEL: Record<WorkflowStep['type'], string> = {
  bash: 'BASH',
  tool: 'TOOL',
  agent_prompt: 'AGENT PROMPT',
  notify: 'NOTIFY',
  conditional: 'CONDITIONAL',
  parallel: 'PARALLEL',
  loop: 'LOOP',
  approval: 'APPROVAL',
};

export function WorkflowStepInspector({ step, onChange, workflow }: Props) {
  // Compute scope once per render so templated inputs and the scope panel share it.
  const scope = useMemo(() => inferScope(workflow, step.id), [workflow, step.id]);
  return (
    <div className="h-full overflow-y-auto px-4 py-4 space-y-4">
      <div>
        <div className="text-[10px] text-neutral-500 dark:text-neutral-400 tracking-wider mb-1">TYPE</div>
        <Badge variant="secondary">
          <StepTypeIcon type={step.type} className="w-3 h-3" />
          {TYPE_LABEL[step.type]}
        </Badge>
      </div>

      <Field label="ID">
        <code className="text-xs font-mono text-neutral-500 dark:text-neutral-400">{step.id}</code>
      </Field>

      <TextField
        label="Name"
        value={step.name}
        onChange={(v) => onChange({ name: v })}
      />

      <TextField
        label="Description"
        value={step.description ?? ''}
        onChange={(v) => onChange({ description: v || undefined })}
      />

      <TextField
        label="Output variable"
        value={step.outputVariable ?? ''}
        placeholder="e.g. myStepOutput"
        onChange={(v) => onChange({ outputVariable: v || undefined })}
        mono
      />

      <TypeSpecificFields step={step} onChange={onChange} scope={scope} />

      <div className="border-t border-border pt-4 mt-4">
        <div className="text-[10px] text-neutral-500 dark:text-neutral-400 tracking-wider mb-2">SCOPE</div>
        <ScopePanel scope={scope} />
      </div>
    </div>
  );
}

function TypeSpecificFields({
  step,
  onChange,
  scope,
}: {
  step: WorkflowStep;
  onChange: (patch: Partial<WorkflowStep>) => void;
  scope: Scope;
}) {
  switch (step.type) {
    case 'bash':
      return (
        <Field label="Command">
          <TemplatedInput
            value={step.command ?? ''}
            onChange={(v) => onChange({ command: v || undefined })}
            scope={scope}
            multiline
            rows={3}
            mono
          />
        </Field>
      );

    case 'tool':
      return (
        <>
          <TextField
            label="Tool"
            value={step.tool ?? ''}
            placeholder="e.g. slack.sendMessage"
            onChange={(v) => onChange({ tool: v || undefined })}
            mono
          />
          <ArgumentsEditor
            args={step.arguments ?? {}}
            onChange={(args) => onChange({ arguments: args })}
          />
        </>
      );

    case 'agent_prompt':
      return (
        <>
          <Field label="Prompt">
            <TemplatedInput
              value={step.prompt ?? ''}
              placeholder="Tell the Valet agent what to do…"
              onChange={(v) => onChange({ prompt: v || undefined })}
              scope={scope}
              multiline
              rows={5}
            />
          </Field>
          <ThreadField step={step} onChange={onChange} />
          <PersonaField step={step} onChange={onChange} />
          <div className="border-t border-border pt-3 space-y-4">
            <NumberField
              label="Timeout (ms)"
              value={step.awaitTimeoutMs ?? 120000}
              onChange={(n) => onChange({ awaitTimeoutMs: n })}
              min={1000}
              max={900000}
            />
            <CheckboxField
              label="Interrupt in-flight turn first"
              checked={step.interrupt === true}
              onChange={(b) => onChange({ interrupt: b || undefined })}
              helper="Aborts any prompt currently running on the target thread before sending this one."
            />
            <OutputSchemaEditor
              schema={step.outputSchema ?? {}}
              onChange={(next) => {
                // Clear field entirely when schema is empty so JSON serialization stays clean.
                const hasFields = Object.keys(next).length > 0;
                onChange({ outputSchema: hasFields ? next : undefined });
              }}
            />
            {step.outputSchema && Object.keys(step.outputSchema).length > 0 && (
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400 italic">
                Schema-validated structured output. Reference fields in later steps as <code>outputs.&lt;outputVariable&gt;.&lt;field&gt;</code>.
              </div>
            )}
            {step.outputSchema && Object.keys(step.outputSchema).length > 0 && !step.outputVariable && (
              <div className="text-[11px] text-amber-600 dark:text-amber-400">
                Set an Output variable to make these fields accessible downstream.
              </div>
            )}
          </div>
        </>
      );

    case 'conditional': {
      const condition = typeof step.condition === 'string' ? step.condition : '';
      const childrenCount = (step.then?.length ?? 0) + (step.else?.length ?? 0);
      return (
        <>
          <Field label="Condition">
            <TemplatedInput
              value={condition}
              placeholder="e.g. outputs.list_runs.failed > 0"
              onChange={(v) => onChange({ condition: v })}
              scope={scope}
              mono
            />
          </Field>
          <Field label="Branches">
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              {step.then?.length ?? 0} then · {step.else?.length ?? 0} else
              {childrenCount > 0 && (
                <span className="block text-[11px] mt-1">
                  Use the chat to add, remove, or reorder branch steps.
                </span>
              )}
            </div>
          </Field>
        </>
      );
    }

    case 'parallel':
      return (
        <Field label="Child steps">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            {step.steps?.length ?? 0} nested step(s).
            <span className="block text-[11px] mt-1">
              Use the chat to add, remove, or reorder nested steps.
            </span>
          </div>
        </Field>
      );

    case 'loop':
      return (
        <>
          <TextField
            label="Over (array path)"
            value={step.over ?? ''}
            placeholder="e.g. outputs.prs.failed or variables.targetUsers"
            onChange={(v) => onChange({ over: v || undefined })}
            mono
          />
          <TextField
            label="Item variable name"
            value={step.itemVar ?? ''}
            placeholder="item (default)"
            onChange={(v) => onChange({ itemVar: v || undefined })}
            mono
          />
          <TextField
            label="Index variable name"
            value={step.indexVar ?? ''}
            placeholder="index (default)"
            onChange={(v) => onChange({ indexVar: v || undefined })}
            mono
          />
          <Field label="Body">
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              {step.steps?.length ?? 0} nested step(s) run per iteration.
              <span className="block text-[11px] mt-1">
                Reference the current item with <code>{`{{loop.item}}`}</code> and the index with <code>{`{{loop.index}}`}</code>.
                Use the chat to add, remove, or reorder body steps.
              </span>
            </div>
          </Field>
        </>
      );

    case 'approval':
      return (
        <Field label="Prompt">
          <TemplatedInput
            value={step.prompt ?? ''}
            onChange={(v) => onChange({ prompt: v || undefined })}
            scope={scope}
            multiline
            rows={3}
          />
        </Field>
      );

    case 'notify':
      return (
        <>
          <Field label="Content">
            <TemplatedInput
              value={step.content ?? ''}
              placeholder="Tell the orchestrator agent what happened (supports {{outputs.foo.bar}} interpolation)…"
              onChange={(v) => onChange({ content: v || undefined })}
              scope={scope}
              multiline
              rows={5}
            />
          </Field>
          <div className="border-t border-border pt-3">
            <Field label="Target">
              <div className="text-xs text-neutral-700 dark:text-neutral-300 bg-surface-2 border border-border rounded px-2.5 py-1.5">
                Your orchestrator agent
              </div>
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">
                Fire-and-forget. The orchestrator decides what to do with this (Slack, message you, take action).
              </div>
            </Field>
          </div>
        </>
      );

    default:
      return null;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-neutral-500 dark:text-neutral-400 tracking-wider mb-1">{label.toUpperCase()}</div>
      {children}
    </div>
  );
}

const INPUT_BASE =
  'w-full rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition';

function TextField({
  label,
  value,
  placeholder,
  onChange,
  mono,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <Field label={label}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_BASE + (mono ? ' font-mono' : '')}
      />
    </Field>
  );
}

function ArgumentsEditor({
  args,
  onChange,
}: {
  args: Record<string, unknown>;
  onChange: (args: Record<string, unknown>) => void;
}) {
  // Split args into "editable" (string/number/bool) and "complex" (object/array/null).
  // Complex values get a JSON-only readout per row so we never silently corrupt them.
  const { editable, complex } = useMemo(() => {
    const editableList: Array<[string, string | number | boolean]> = [];
    const complexList: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        editableList.push([k, v]);
      } else {
        complexList.push([k, v]);
      }
    }
    return { editable: editableList, complex: complexList };
  }, [args]);

  const [newKey, setNewKey] = useState('');

  const setKeyValue = (key: string, value: string | number | boolean) => {
    onChange({ ...args, [key]: value });
  };

  const renameKey = (oldKey: string, newName: string) => {
    if (!newName || newName === oldKey || newName in args) return;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      next[k === oldKey ? newName : k] = v;
    }
    onChange(next);
  };

  const removeKey = (key: string) => {
    const next = { ...args };
    delete next[key];
    onChange(next);
  };

  const addKey = () => {
    const name = newKey.trim();
    if (!name || name in args) return;
    onChange({ ...args, [name]: '' });
    setNewKey('');
  };

  return (
    <Field label="Arguments">
      {editable.length === 0 && complex.length === 0 && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">No arguments yet.</div>
      )}
      <div className="space-y-1.5">
        {editable.map(([k, v]) => (
          <ArgRow
            key={k}
            argKey={k}
            argValue={v}
            onRename={(name) => renameKey(k, name)}
            onValueChange={(val) => setKeyValue(k, val)}
            onRemove={() => removeKey(k)}
          />
        ))}
        {complex.map(([k, v]) => (
          <div
            key={k}
            className="flex items-start gap-1 text-xs border border-border rounded p-1.5 bg-surface-2"
          >
            <span className="font-mono font-semibold text-neutral-700 dark:text-neutral-300 shrink-0">{k}:</span>
            <code className="font-mono text-neutral-500 dark:text-neutral-400 break-all flex-1 min-w-0">
              {safeStringify(v)}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeKey(k)}
              className="!h-6 !w-6 !p-0"
              aria-label={`Remove argument ${k}`}
            >
              <X className="w-3 h-3" strokeWidth={1.5} />
            </Button>
          </div>
        ))}
        {complex.length > 0 && (
          <div className="text-[10px] text-neutral-500 dark:text-neutral-400 italic">
            Complex values (objects/arrays) are read-only here — edit via JSON tab.
          </div>
        )}
      </div>
      <div className="flex gap-1 mt-2">
        <input
          type="text"
          value={newKey}
          placeholder="New argument name"
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addKey();
            }
          }}
          className="flex-1 rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition"
        />
        <Button variant="secondary" size="sm" onClick={addKey} disabled={!newKey.trim()}>
          Add
        </Button>
      </div>
    </Field>
  );
}

function ArgRow({
  argKey,
  argValue,
  onRename,
  onValueChange,
  onRemove,
}: {
  argKey: string;
  argValue: string | number | boolean;
  onRename: (newName: string) => void;
  onValueChange: (v: string | number | boolean) => void;
  onRemove: () => void;
}) {
  const valueType = typeof argValue;
  // Common input classes for the small grid rows — slimmer padding than INPUT_BASE.
  const slim =
    'rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition';
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        defaultValue={argKey}
        onBlur={(e) => {
          if (e.target.value !== argKey) onRename(e.target.value);
        }}
        className={`w-28 shrink-0 font-mono ${slim}`}
      />
      {valueType === 'boolean' ? (
        <select
          value={String(argValue)}
          onChange={(e) => onValueChange(e.target.value === 'true')}
          className={`flex-1 min-w-0 ${slim}`}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          type="text"
          value={String(argValue)}
          onChange={(e) => {
            const raw = e.target.value;
            if (valueType === 'number') {
              const n = Number(raw);
              onValueChange(Number.isFinite(n) ? n : raw);
            } else {
              onValueChange(raw);
            }
          }}
          className={`flex-1 min-w-0 font-mono ${slim}`}
        />
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        className="!h-6 !w-6 !p-0 shrink-0"
        aria-label={`Remove argument ${argKey}`}
      >
        <X className="w-3 h-3" strokeWidth={1.5} />
      </Button>
    </div>
  );
}

function ThreadField({ step, onChange }: { step: WorkflowStep; onChange: (patch: Partial<WorkflowStep>) => void }) {
  return (
    <Field label="Thread">
      <div className="flex gap-1">
        <input
          type="text"
          value={step.thread ?? ''}
          placeholder="(shared workflow thread)"
          onChange={(e) => onChange({ thread: e.target.value || undefined })}
          className={INPUT_BASE + ' flex-1 min-w-0 font-mono'}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange({ thread: '@new' })}
          className="shrink-0"
        >
          <Plus className="w-3 h-3" strokeWidth={1.5} />
          new
        </Button>
      </div>
      <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">
        Name a thread to share context across steps. <code>@new</code> spawns a fresh thread per call.
      </div>
    </Field>
  );
}

function PersonaField({ step, onChange }: { step: WorkflowStep; onChange: (patch: Partial<WorkflowStep>) => void }) {
  // Personas come from the user's org. An empty value clears the override so
  // the call uses OpenCode's default per-session system prompt.
  const { data: personas, isLoading } = usePersonas();
  return (
    <Field label="Persona">
      <select
        value={step.persona ?? ''}
        onChange={(e) => onChange({ persona: e.target.value || undefined })}
        className={INPUT_BASE}
        disabled={isLoading}
      >
        <option value="">Default (no persona)</option>
        {(personas ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">
        Override the agent's system prompt for this step.
      </div>
    </Field>
  );
}

function CheckboxField({ label, checked, onChange, helper }: { label: string; checked: boolean; onChange: (b: boolean) => void; helper?: string }) {
  return (
    <Field label={label}>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-accent"
        />
        <span>{checked ? 'On' : 'Off'}</span>
      </label>
      {helper && <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">{helper}</div>}
    </Field>
  );
}

function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className={INPUT_BASE + ' font-mono'}
      />
    </Field>
  );
}

type SchemaFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';
type SchemaField = { type: SchemaFieldType; description?: string };
type OutputSchema = Record<string, SchemaField>;

const TYPE_OPTIONS: Array<SchemaFieldType> = ['string', 'number', 'boolean', 'array', 'object'];
const VALID_FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function OutputSchemaEditor({
  schema,
  onChange,
}: {
  schema: OutputSchema;
  onChange: (next: OutputSchema) => void;
}) {
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const entries = Object.entries(schema);

  const renameField = (oldKey: string, newKey: string) => {
    if (!newKey || newKey === oldKey) return false;
    if (newKey in schema) return false;
    if (!VALID_FIELD_NAME.test(newKey)) return false;
    // Preserve insertion order during rename.
    const next: OutputSchema = {};
    for (const [k, v] of Object.entries(schema)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
    return true;
  };

  const updateType = (key: string, type: SchemaFieldType) => {
    onChange({ ...schema, [key]: { ...schema[key], type } });
  };

  const updateDescription = (key: string, description: string) => {
    const trimmed = description.trim();
    onChange({
      ...schema,
      [key]: { type: schema[key].type, ...(trimmed ? { description: trimmed } : {}) },
    });
  };

  const removeField = (key: string) => {
    const next = { ...schema };
    delete next[key];
    onChange(next);
  };

  const addField = () => {
    const name = newName.trim();
    if (!name) return;
    if (!VALID_FIELD_NAME.test(name)) {
      setAddError('Invalid name. Use letters, numbers, underscores; must not start with a digit.');
      return;
    }
    if (name in schema) {
      setAddError('A field with that name already exists.');
      return;
    }
    onChange({ ...schema, [name]: { type: 'string' } });
    setNewName('');
    setAddError(null);
  };

  return (
    <Field label="Output schema">
      {entries.length === 0 && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
          No structured outputs configured. Agent will return free-form text.
        </div>
      )}
      <div className="space-y-1.5">
        {entries.map(([key, field]) => (
          <SchemaFieldRow
            key={key}
            fieldKey={key}
            field={field}
            onRename={(next) => renameField(key, next)}
            onTypeChange={(t) => updateType(key, t)}
            onDescriptionChange={(d) => updateDescription(key, d)}
            onRemove={() => removeField(key)}
          />
        ))}
      </div>
      <div className="flex gap-1 mt-2">
        <input
          type="text"
          value={newName}
          placeholder="New field name"
          onChange={(e) => {
            setNewName(e.target.value);
            if (addError) setAddError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addField();
            }
          }}
          className="flex-1 rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition"
        />
        <Button variant="secondary" size="sm" onClick={addField} disabled={!newName.trim()}>
          <Plus className="w-3 h-3" strokeWidth={1.5} />
          Add field
        </Button>
      </div>
      {addError && <div className="text-[11px] text-red-600 dark:text-red-400 mt-1">{addError}</div>}
    </Field>
  );
}

function SchemaFieldRow({
  fieldKey,
  field,
  onRename,
  onTypeChange,
  onDescriptionChange,
  onRemove,
}: {
  fieldKey: string;
  field: SchemaField;
  onRename: (next: string) => boolean;
  onTypeChange: (t: SchemaFieldType) => void;
  onDescriptionChange: (d: string) => void;
  onRemove: () => void;
}) {
  const slim =
    'rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition';
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        defaultValue={fieldKey}
        onBlur={(e) => {
          const next = e.target.value;
          if (next !== fieldKey) {
            const ok = onRename(next);
            // Revert the input if rename was rejected so the UI stays in sync with state.
            if (!ok) e.target.value = fieldKey;
          }
        }}
        className={`w-24 shrink-0 font-mono ${slim}`}
      />
      <select
        value={field.type}
        onChange={(e) => {
          const v = e.target.value;
          // Narrow the raw string from the DOM event against the known type list.
          const match = TYPE_OPTIONS.find((opt) => opt === v);
          if (match) onTypeChange(match);
        }}
        className={`w-20 shrink-0 ${slim}`}
      >
        {TYPE_OPTIONS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <input
        type="text"
        defaultValue={field.description ?? ''}
        placeholder="description"
        onBlur={(e) => {
          if (e.target.value !== (field.description ?? '')) {
            onDescriptionChange(e.target.value);
          }
        }}
        className={`flex-1 min-w-0 ${slim}`}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        className="!h-6 !w-6 !p-0 shrink-0"
        aria-label={`Remove field ${fieldKey}`}
      >
        <X className="w-3 h-3" strokeWidth={1.5} />
      </Button>
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
