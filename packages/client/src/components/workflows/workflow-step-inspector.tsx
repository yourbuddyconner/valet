import { useMemo, useState } from 'react';
import type { WorkflowStep } from '@/api/workflows';

interface Props {
  step: WorkflowStep;
  onChange: (patch: Partial<WorkflowStep>) => void;
}

const TYPE_LABEL: Record<WorkflowStep['type'], string> = {
  bash: 'BASH',
  tool: 'TOOL',
  agent: 'AGENT',
  agent_message: 'AGENT MESSAGE',
  conditional: 'CONDITIONAL',
  parallel: 'PARALLEL',
  loop: 'LOOP',
  subworkflow: 'SUBWORKFLOW',
  approval: 'APPROVAL',
};

export function WorkflowStepInspector({ step, onChange }: Props) {
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
    </div>
  );
}

function TypeSpecificFields({ step, onChange }: Props) {
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

    case 'agent_message':
      return (
        <TextAreaField
          label="Message content"
          value={step.content ?? ''}
          onChange={(v) => onChange({ content: v || undefined })}
          rows={4}
        />
      );

    case 'agent':
      return (
        <>
          <TextAreaField
            label="Goal"
            value={step.goal ?? ''}
            onChange={(v) => onChange({ goal: v || undefined })}
            rows={3}
          />
          <TextAreaField
            label="Prompt"
            value={step.prompt ?? ''}
            onChange={(v) => onChange({ prompt: v || undefined })}
            rows={3}
          />
          <TextAreaField
            label="Content"
            value={step.content ?? ''}
            onChange={(v) => onChange({ content: v || undefined })}
            rows={3}
          />
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
    case 'loop':
    case 'subworkflow':
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

    case 'approval':
      return (
        <TextAreaField
          label="Prompt"
          value={step.prompt ?? ''}
          onChange={(v) => onChange({ prompt: v || undefined })}
          rows={3}
        />
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

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
