import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { VariableDefinition } from '@/api/workflows';
import { Button } from '@/components/ui/button';

const INPUT_BASE =
  'rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition';

interface Props {
  variables: Record<string, VariableDefinition>;
  onChange: (next: Record<string, VariableDefinition>) => void;
}

type VarType = VariableDefinition['type'];

const TYPE_OPTIONS: ReadonlyArray<VarType> = ['string', 'number', 'boolean', 'array', 'object'];
const VALID_VAR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function WorkflowVariablesEditor({ variables, onChange }: Props) {
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const entries = Object.entries(variables);

  const renameVariable = (oldKey: string, newKey: string): boolean => {
    if (!newKey || newKey === oldKey) return false;
    if (newKey in variables) return false;
    if (!VALID_VAR_NAME.test(newKey)) return false;
    // Preserve insertion order during rename.
    const next: Record<string, VariableDefinition> = {};
    for (const [k, v] of Object.entries(variables)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
    return true;
  };

  const updateVariable = (key: string, patch: Partial<VariableDefinition>) => {
    onChange({ ...variables, [key]: { ...variables[key], ...patch } });
  };

  const removeVariable = (key: string) => {
    const next = { ...variables };
    delete next[key];
    onChange(next);
  };

  const addVariable = () => {
    const name = newName.trim();
    if (!name) return;
    if (!VALID_VAR_NAME.test(name)) {
      setAddError('Invalid name. Use letters, numbers, underscores; must not start with a digit.');
      return;
    }
    if (name in variables) {
      setAddError('A variable with that name already exists.');
      return;
    }
    onChange({ ...variables, [name]: { type: 'string' } });
    setNewName('');
    setAddError(null);
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-4 space-y-3">
      <div className="flex gap-1">
        <input
          type="text"
          value={newName}
          placeholder="New variable name"
          onChange={(e) => {
            setNewName(e.target.value);
            if (addError) setAddError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addVariable();
            }
          }}
          className={INPUT_BASE + ' flex-1 font-mono'}
        />
        <Button variant="ghost" size="sm" onClick={addVariable} disabled={!newName.trim()}>
          <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
          Add variable
        </Button>
      </div>
      {addError && <div className="text-[11px] text-red-600 dark:text-red-400">{addError}</div>}

      {entries.length === 0 ? (
        <div className="text-xs text-neutral-500 dark:text-neutral-400 italic pt-2">
          No variables declared. Variables let the workflow accept inputs at run time.
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, def]) => (
            <VariableCard
              key={key}
              varKey={key}
              def={def}
              onRename={(next) => renameVariable(key, next)}
              onUpdate={(patch) => updateVariable(key, patch)}
              onRemove={() => removeVariable(key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VariableCard({
  varKey,
  def,
  onRename,
  onUpdate,
  onRemove,
}: {
  varKey: string;
  def: VariableDefinition;
  onRename: (next: string) => boolean;
  onUpdate: (patch: Partial<VariableDefinition>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="bg-surface-2 border border-border rounded-md p-2.5 space-y-2">
      <div className="flex items-center gap-1">
        <input
          type="text"
          defaultValue={varKey}
          onBlur={(e) => {
            const next = e.target.value;
            if (next !== varKey) {
              const ok = onRename(next);
              // Revert if rejected so UI stays consistent with state.
              if (!ok) e.target.value = varKey;
            }
          }}
          className={INPUT_BASE + ' flex-1 min-w-0 font-mono'}
        />
        <select
          value={def.type}
          onChange={(e) => {
            const v = e.target.value;
            const match = TYPE_OPTIONS.find((opt) => opt === v);
            if (match) {
              // Reset default when changing type — old value likely doesn't fit new type.
              onUpdate({ type: match, default: undefined });
            }
          }}
          className={INPUT_BASE + ' w-20 shrink-0'}
        >
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="!h-6 !w-6 !p-0 shrink-0"
          aria-label={`Remove variable ${varKey}`}
        >
          <X className="w-3 h-3" strokeWidth={1.5} />
        </Button>
      </div>

      <div>
        <div className="text-[10px] text-neutral-500 dark:text-neutral-400 tracking-wider mb-1">DESCRIPTION</div>
        <input
          type="text"
          defaultValue={def.description ?? ''}
          placeholder="What is this variable for?"
          onBlur={(e) => {
            const trimmed = e.target.value.trim();
            if (trimmed !== (def.description ?? '')) {
              onUpdate({ description: trimmed || undefined });
            }
          }}
          className={INPUT_BASE + ' w-full'}
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={def.required === true}
          onChange={(e) => onUpdate({ required: e.target.checked ? true : undefined })}
          className="accent-accent"
        />
        <span>Required</span>
      </label>

      <DefaultValueEditor
        type={def.type}
        value={def.default}
        onChange={(next) => onUpdate({ default: next })}
      />
    </div>
  );
}

function DefaultValueEditor({
  type,
  value,
  onChange,
}: {
  type: VarType;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  return (
    <div>
      <div className="text-[10px] text-neutral-500 dark:text-neutral-400 tracking-wider mb-1">DEFAULT</div>
      <DefaultInput type={type} value={value} onChange={onChange} />
    </div>
  );
}

function DefaultInput({
  type,
  value,
  onChange,
}: {
  type: VarType;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (type === 'string') {
    const str = typeof value === 'string' ? value : '';
    return (
      <input
        type="text"
        value={str}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        placeholder="(no default)"
        className={INPUT_BASE + ' w-full'}
      />
    );
  }

  if (type === 'number') {
    const num = typeof value === 'number' ? value : '';
    return (
      <input
        type="number"
        value={num === '' ? '' : String(num)}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(undefined);
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        placeholder="(no default)"
        className={INPUT_BASE + ' w-full font-mono'}
      />
    );
  }

  if (type === 'boolean') {
    const checked = value === true;
    return (
      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-accent"
        />
        <span>{checked ? 'true' : 'false'}</span>
      </label>
    );
  }

  // array / object → JSON textarea
  return <JsonDefaultInput type={type} value={value} onChange={onChange} />;
}

function JsonDefaultInput({
  type,
  value,
  onChange,
}: {
  type: 'array' | 'object';
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const upstream = value === undefined ? '' : safeStringify(value);
  const [draft, setDraft] = useState(upstream);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local draft when upstream resets (e.g. type change clears the default).
  // Skipping when there's an unresolved parse error avoids clobbering in-progress edits.
  useEffect(() => {
    if (error === null) setDraft(upstream);
  }, [upstream, error]);

  const placeholder = type === 'array' ? '[]' : '{}';

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange(undefined);
      setError(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (type === 'array' && !Array.isArray(parsed)) {
        setError('Default must be a JSON array.');
        return;
      }
      if (type === 'object') {
        const isPlainObject =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        if (!isPlainObject) {
          setError('Default must be a JSON object.');
          return;
        }
      }
      onChange(parsed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  return (
    <div>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onBlur={(e) => commit(e.target.value)}
        rows={3}
        placeholder={placeholder}
        className={INPUT_BASE + ' w-full font-mono resize-y'}
      />
      {error && <div className="text-[11px] text-red-600 dark:text-red-400 mt-1">{error}</div>}
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '';
  }
}
