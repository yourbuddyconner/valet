import { useMemo, useState } from 'react';
import type { WorkflowData, WorkflowStep } from '@/api/workflows';
import { inferScope } from './scope-inferencer';
import { ScopePanel } from './scope-panel';

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
  return (
    <div className="h-full overflow-y-auto px-4 py-4 space-y-4">
      <div>
        <div className="text-[10px] text-neutral-500 tracking-wider mb-0.5">TYPE</div>
        <span className="text-[10px] font-bold tracking-wider bg-neutral-900 text-white px-1.5 py-0.5 rounded">
          {TYPE_LABEL[step.type]}
        </span>
      </div>

      <Field label="ID">
        <code className="text-xs font-mono text-neutral-600">{step.id}</code>
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

      <TypeSpecificFields step={step} onChange={onChange} />

      <div className="border-t border-neutral-200 pt-4 mt-2">
        <div className="text-[10px] text-neutral-500 tracking-wider mb-2">SCOPE</div>
        <ScopePanel scope={inferScope(workflow, step.id)} />
      </div>
    </div>
  );
}

function TypeSpecificFields({
  step,
  onChange,
}: {
  step: WorkflowStep;
  onChange: (patch: Partial<WorkflowStep>) => void;
}) {
  switch (step.type) {
    case 'bash':
      return (
        <TextAreaField
          label="Command"
          value={step.command ?? ''}
          onChange={(v) => onChange({ command: v || undefined })}
          mono
          rows={3}
        />
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
          <TextAreaField
            label="Prompt"
            value={step.prompt ?? ''}
            placeholder="Tell the Valet agent what to do…"
            onChange={(v) => onChange({ prompt: v || undefined })}
            rows={5}
          />
          <ThreadField step={step} onChange={onChange} />
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
            <div className="text-[11px] text-neutral-500 italic">
              Schema-validated structured output. Reference fields in later steps as <code>outputs.&lt;outputVariable&gt;.&lt;field&gt;</code>.
            </div>
          )}
          {step.outputSchema && Object.keys(step.outputSchema).length > 0 && !step.outputVariable && (
            <div className="text-[11px] text-amber-600">
              Set an Output variable to make these fields accessible downstream.
            </div>
          )}
        </>
      );

    case 'conditional': {
      const condition = typeof step.condition === 'string' ? step.condition : '';
      const childrenCount = (step.then?.length ?? 0) + (step.else?.length ?? 0);
      return (
        <>
          <TextField
            label="Condition"
            value={condition}
            placeholder="e.g. outputs.list_runs.failed > 0"
            onChange={(v) => onChange({ condition: v })}
            mono
          />
          <Field label="Branches">
            <div className="text-xs text-neutral-500">
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
          <div className="text-xs text-neutral-500">
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
            <div className="text-xs text-neutral-500">
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
        <TextAreaField
          label="Prompt"
          value={step.prompt ?? ''}
          onChange={(v) => onChange({ prompt: v || undefined })}
          rows={3}
        />
      );

    case 'notify':
      return (
        <>
          <TextAreaField
            label="Content"
            value={step.content ?? ''}
            placeholder="Tell the orchestrator agent what happened (supports {{outputs.foo.bar}} interpolation)…"
            onChange={(v) => onChange({ content: v || undefined })}
            rows={5}
          />
          <Field label="Target">
            <div className="text-xs text-neutral-700 bg-neutral-50 border border-neutral-200 rounded px-2.5 py-1.5">
              Your orchestrator agent
            </div>
            <div className="text-[11px] text-neutral-500 mt-1">
              Fire-and-forget. The orchestrator decides what to do with this (Slack, message you, take action).
            </div>
          </Field>
        </>
      );

    default:
      return null;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-neutral-500 tracking-wider mb-1">{label.toUpperCase()}</div>
      {children}
    </div>
  );
}

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
        className={
          'w-full rounded-md border border-neutral-300 px-2 py-1 text-sm ' +
          (mono ? 'font-mono' : '')
        }
      />
    </Field>
  );
}

function TextAreaField({
  label,
  value,
  placeholder,
  onChange,
  mono,
  rows = 3,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  mono?: boolean;
  rows?: number;
}) {
  return (
    <Field label={label}>
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={
          'w-full rounded-md border border-neutral-300 px-2 py-1 text-sm resize-y ' +
          (mono ? 'font-mono' : '')
        }
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
        <div className="text-xs text-neutral-500 mb-2">No arguments yet.</div>
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
            className="flex items-start gap-1 text-xs border border-neutral-200 rounded p-1.5 bg-neutral-50"
          >
            <span className="font-mono font-semibold text-neutral-700 shrink-0">{k}:</span>
            <code className="font-mono text-neutral-600 break-all flex-1 min-w-0">
              {safeStringify(v)}
            </code>
            <button
              onClick={() => removeKey(k)}
              className="text-neutral-400 hover:text-red-600 px-1"
              aria-label={`Remove argument ${k}`}
            >
              ×
            </button>
          </div>
        ))}
        {complex.length > 0 && (
          <div className="text-[10px] text-neutral-500 italic">
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
          className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs font-mono"
        />
        <button
          onClick={addKey}
          disabled={!newKey.trim()}
          className="px-2 py-1 text-xs border border-neutral-300 rounded-md hover:bg-neutral-50 disabled:opacity-50"
        >
          + Add
        </button>
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
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        defaultValue={argKey}
        onBlur={(e) => {
          if (e.target.value !== argKey) onRename(e.target.value);
        }}
        className="w-28 shrink-0 rounded-md border border-neutral-300 px-1.5 py-1 text-xs font-mono"
      />
      {valueType === 'boolean' ? (
        <select
          value={String(argValue)}
          onChange={(e) => onValueChange(e.target.value === 'true')}
          className="flex-1 min-w-0 rounded-md border border-neutral-300 px-1.5 py-1 text-xs"
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
          className="flex-1 min-w-0 rounded-md border border-neutral-300 px-1.5 py-1 text-xs font-mono"
        />
      )}
      <button
        onClick={onRemove}
        className="text-neutral-400 hover:text-red-600 px-1 shrink-0"
        aria-label={`Remove argument ${argKey}`}
      >
        ×
      </button>
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
          className="flex-1 min-w-0 rounded-md border border-neutral-300 px-2 py-1 text-sm font-mono"
        />
        <button
          type="button"
          onClick={() => onChange({ thread: '@new' })}
          className="text-xs px-2 py-1 border border-neutral-300 rounded-md hover:bg-neutral-50 shrink-0"
        >
          @new
        </button>
      </div>
      <div className="text-[11px] text-neutral-500 mt-1">
        Name a thread to share context across steps. <code>@new</code> spawns a fresh thread per call.
      </div>
    </Field>
  );
}

function CheckboxField({ label, checked, onChange, helper }: { label: string; checked: boolean; onChange: (b: boolean) => void; helper?: string }) {
  return (
    <Field label={label}>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{checked ? 'On' : 'Off'}</span>
      </label>
      {helper && <div className="text-[11px] text-neutral-500 mt-1">{helper}</div>}
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
        className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm font-mono"
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
        <div className="text-xs text-neutral-500 mb-2">
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
          className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs font-mono"
        />
        <button
          onClick={addField}
          disabled={!newName.trim()}
          className="px-2 py-1 text-xs border border-neutral-300 rounded-md hover:bg-neutral-50 disabled:opacity-50"
        >
          + Add field
        </button>
      </div>
      {addError && <div className="text-[11px] text-red-600 mt-1">{addError}</div>}
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
        className="w-24 shrink-0 rounded-md border border-neutral-300 px-1.5 py-1 text-xs font-mono"
      />
      <select
        value={field.type}
        onChange={(e) => {
          const v = e.target.value;
          // Narrow the raw string from the DOM event against the known type list.
          const match = TYPE_OPTIONS.find((opt) => opt === v);
          if (match) onTypeChange(match);
        }}
        className="w-20 shrink-0 rounded-md border border-neutral-300 px-1 py-1 text-xs"
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
        className="flex-1 min-w-0 rounded-md border border-neutral-300 px-1.5 py-1 text-xs"
      />
      <button
        onClick={onRemove}
        className="text-neutral-400 hover:text-red-600 px-1 shrink-0"
        aria-label={`Remove field ${fieldKey}`}
      >
        ×
      </button>
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
