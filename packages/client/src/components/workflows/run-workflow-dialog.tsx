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
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import type { VariableDefinition } from '@/api/workflows';

interface Props {
  // Display name (e.g. workflow name or draft name).
  name: string;
  // Variable schema keyed by variable name. Pass {} when there are no variables.
  variables: Record<string, VariableDefinition>;
  onConfirm: (values: Record<string, unknown>) => void;
  onClose: () => void;
  loading: boolean;
  // Override the primary action label (default: "Run workflow").
  confirmLabel?: string;
  // Override the dialog title (default: "Run {name}").
  title?: string;
  // Override the dialog description.
  description?: string;
}

// Each field stores its raw text/checkbox state. We parse to typed values at confirm time.
interface FieldState {
  raw: string;
  checked: boolean;
}

function initialFieldState(def: VariableDefinition): FieldState {
  const { type, default: dflt } = def;
  if (type === 'boolean') {
    return { raw: '', checked: typeof dflt === 'boolean' ? dflt : false };
  }
  if (dflt === undefined || dflt === null) {
    return { raw: '', checked: false };
  }
  if (type === 'array' || type === 'object') {
    return { raw: JSON.stringify(dflt, null, 2), checked: false };
  }
  return { raw: String(dflt), checked: false };
}

interface ParseResult {
  value?: unknown;
  error?: string;
}

function parseField(def: VariableDefinition, state: FieldState): ParseResult {
  const required = def.required === true;
  switch (def.type) {
    case 'boolean':
      return { value: state.checked };
    case 'string': {
      const raw = state.raw;
      if (raw.length === 0) {
        if (required) return { error: 'Required' };
        return { value: '' };
      }
      return { value: raw };
    }
    case 'number': {
      const raw = state.raw.trim();
      if (raw.length === 0) {
        if (required) return { error: 'Required' };
        return { value: undefined };
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: 'Must be a number' };
      return { value: n };
    }
    case 'array':
    case 'object': {
      const raw = state.raw.trim();
      if (raw.length === 0) {
        if (required) return { error: 'Required' };
        return { value: undefined };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { error: 'Invalid JSON' };
      }
      if (def.type === 'array' && !Array.isArray(parsed)) {
        return { error: 'Must be a JSON array' };
      }
      if (
        def.type === 'object' &&
        (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      ) {
        return { error: 'Must be a JSON object' };
      }
      return { value: parsed };
    }
  }
}

function typeBadgeVariant(type: VariableDefinition['type']): 'default' | 'secondary' {
  // Booleans and numbers feel "lighter" — use secondary to differentiate from strings/json
  return type === 'boolean' || type === 'number' ? 'secondary' : 'default';
}

export function RunWorkflowDialog({
  name,
  variables,
  onConfirm,
  onClose,
  loading,
  confirmLabel,
  title,
  description,
}: Props) {
  const entries = React.useMemo(() => Object.entries(variables), [variables]);

  const [state, setState] = React.useState<Record<string, FieldState>>(() => {
    const initial: Record<string, FieldState> = {};
    for (const [name, def] of Object.entries(variables)) {
      initial[name] = initialFieldState(def);
    }
    return initial;
  });

  const parsed = React.useMemo(() => {
    const out: Record<string, ParseResult> = {};
    for (const [name, def] of entries) {
      out[name] = parseField(def, state[name] ?? initialFieldState(def));
    }
    return out;
  }, [entries, state]);

  const hasError = Object.values(parsed).some((p) => p.error !== undefined);

  const handleConfirm = () => {
    if (hasError) return;
    const values: Record<string, unknown> = {};
    for (const [name, result] of Object.entries(parsed)) {
      // Skip optional fields left empty so the runner can apply its own defaults.
      if (result.value === undefined) continue;
      values[name] = result.value;
    }
    onConfirm(values);
  };

  const updateRaw = (name: string, raw: string) => {
    setState((prev) => ({ ...prev, [name]: { ...(prev[name] ?? { raw: '', checked: false }), raw } }));
  };
  const updateChecked = (name: string, checked: boolean) => {
    setState((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? { raw: '', checked: false }), checked },
    }));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !loading) onClose();
      }}
    >
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title ?? `Run ${name}`}</DialogTitle>
          <DialogDescription>
            {description ?? 'This workflow requires inputs. Provide values to continue.'}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-5">
          {entries.map(([name, def]) => {
            const fieldState = state[name] ?? initialFieldState(def);
            const result = parsed[name];
            const error = result?.error;
            const inputId = `var-${name}`;
            // Use a textarea when the value is multi-line capable: arrays, objects, or strings with
            // a description hinting at longer content.
            const useTextarea =
              def.type === 'array' ||
              def.type === 'object' ||
              (def.type === 'string' &&
                !!def.description &&
                /paragraph|multi|long|body|markdown|message|prompt/i.test(def.description));

            return (
              <div
                key={name}
                className="space-y-1.5 bg-surface-2 border border-border rounded-md p-2.5 focus-within:ring-2 focus-within:ring-accent/40 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <label
                    htmlFor={inputId}
                    className="font-mono text-sm text-foreground"
                  >
                    {name}
                  </label>
                  <Badge variant={typeBadgeVariant(def.type)}>{def.type}</Badge>
                  {def.required && (
                    <span className="text-red-500 text-sm" aria-label="required">
                      *
                    </span>
                  )}
                </div>
                {def.description && (
                  <div className="text-xs text-neutral-500">{def.description}</div>
                )}

                {def.type === 'boolean' ? (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={inputId}
                      checked={fieldState.checked}
                      onChange={(e) => updateChecked(name, e.target.checked)}
                    />
                    <label htmlFor={inputId} className="text-sm text-neutral-700 dark:text-neutral-300">
                      {fieldState.checked ? 'true' : 'false'}
                    </label>
                  </div>
                ) : useTextarea ? (
                  <textarea
                    id={inputId}
                    value={fieldState.raw}
                    onChange={(e) => updateRaw(name, e.target.value)}
                    rows={def.type === 'object' || def.type === 'array' ? 5 : 3}
                    className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm font-mono shadow-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                    placeholder={
                      def.type === 'array'
                        ? '[]'
                        : def.type === 'object'
                          ? '{}'
                          : undefined
                    }
                  />
                ) : (
                  <Input
                    id={inputId}
                    type={def.type === 'number' ? 'number' : 'text'}
                    value={fieldState.raw}
                    onChange={(e) => updateRaw(name, e.target.value)}
                  />
                )}

                {error && <div className="text-xs text-red-500">{error}</div>}
              </div>
            );
          })}
        </div>

        <DialogFooter className="mt-6">
          <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={handleConfirm} disabled={hasError || loading}>
            {loading ? 'Running…' : (confirmLabel ?? 'Run workflow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
