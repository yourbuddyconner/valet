import { Badge } from '@/components/ui/badge';
import type { VariableDefinition } from '@/api/workflows';

interface TriggerValue {
  kind: 'schedule' | 'webhook' | 'manual';
  config: Record<string, unknown>;
}

interface Props {
  value: TriggerValue | null;
  onChange: (v: TriggerValue | null) => void;
  availableVariables?: Record<string, VariableDefinition>;
}

// Reused input styling — surface tokens, accent focus ring, dark-mode safe.
const INPUT_BASE =
  'w-full rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition';

export function WorkflowDraftTriggerForm({ value, onChange, availableVariables }: Props) {
  const kind = value?.kind ?? 'manual';

  // Bridge from Record<string, unknown> index access to input default strings.
  const cron = typeof value?.config.cron === 'string' ? value.config.cron : '0 9 * * *';
  const timezone =
    typeof value?.config.timezone === 'string' ? value.config.timezone : 'America/Los_Angeles';
  const path = typeof value?.config.path === 'string' ? value.config.path : '';
  const method = typeof value?.config.method === 'string' ? value.config.method : 'POST';

  // Extract current variableMapping from config (stored alongside path/method).
  const rawMapping = value?.config.variableMapping;
  const variableMapping: Record<string, string> =
    rawMapping && typeof rawMapping === 'object' && !Array.isArray(rawMapping)
      ? (rawMapping as Record<string, string>)
      : {};

  const variableEntries = Object.entries(availableVariables ?? {});

  return (
    <div className="px-6 py-4 bg-surface-1 border-t border-border">
      <div className="text-sm font-semibold text-foreground mb-2">How should this run?</div>
      <div className="inline-flex bg-surface-2 rounded-md p-0.5 mb-3">
        {(['schedule', 'webhook', 'manual'] as const).map((k) => {
          const active = kind === k;
          return (
            <button
              key={k}
              onClick={() => onChange({ kind: k, config: defaultConfig(k) })}
              aria-pressed={active}
              className={
                'px-3 py-1 text-xs font-mono uppercase tracking-wider rounded transition-colors ' +
                (active
                  ? 'bg-surface-0 text-foreground shadow-panel'
                  : 'text-neutral-500 hover:text-foreground')
              }
            >
              {k}
            </button>
          );
        })}
      </div>
      {kind === 'schedule' && (
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500 dark:text-neutral-400">Cron</span>
            <input
              type="text"
              value={cron}
              onChange={(e) =>
                onChange({ kind: 'schedule', config: { ...value?.config, cron: e.target.value } })
              }
              className={INPUT_BASE + ' font-mono'}
            />
          </label>
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500 dark:text-neutral-400">Timezone</span>
            <input
              type="text"
              value={timezone}
              onChange={(e) =>
                onChange({
                  kind: 'schedule',
                  config: { ...value?.config, timezone: e.target.value },
                })
              }
              className={INPUT_BASE}
            />
          </label>
        </div>
      )}
      {kind === 'webhook' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 max-w-lg">
            <label className="text-xs">
              <span className="block mb-1 text-neutral-500 dark:text-neutral-400">Path</span>
              <input
                type="text"
                value={path}
                onChange={(e) =>
                  onChange({ kind: 'webhook', config: { ...value?.config, path: e.target.value } })
                }
                placeholder="my-workflow"
                className={INPUT_BASE + ' font-mono'}
              />
            </label>
            <label className="text-xs">
              <span className="block mb-1 text-neutral-500 dark:text-neutral-400">Method</span>
              <select
                value={method}
                onChange={(e) =>
                  onChange({ kind: 'webhook', config: { ...value?.config, method: e.target.value } })
                }
                className={INPUT_BASE}
              >
                <option>POST</option>
                <option>GET</option>
              </select>
            </label>
          </div>
          <Field label="Payload mapping (optional)">
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
              Map workflow variables to JSON paths in the incoming webhook payload. Use{' '}
              <span className="font-mono">$.field</span> or{' '}
              <span className="font-mono">$.nested.field</span> syntax.
            </p>
            {variableEntries.length === 0 ? (
              <div className="text-xs text-neutral-500 dark:text-neutral-400 italic bg-surface-2 border border-border rounded-md px-3 py-2">
                Declare workflow variables first (Variables tab) — then map them here.
              </div>
            ) : (
              <div className="space-y-2 max-w-2xl">
                {variableEntries.map(([varName, def]) => (
                  <PayloadMappingRow
                    key={varName}
                    varName={varName}
                    def={def}
                    initialValue={variableMapping[varName] ?? ''}
                    onCommit={(nextPath) => {
                      const nextMapping: Record<string, string> = { ...variableMapping };
                      const trimmed = nextPath.trim();
                      if (trimmed) {
                        nextMapping[varName] = trimmed;
                      } else {
                        delete nextMapping[varName];
                      }
                      onChange({
                        kind: 'webhook',
                        config: {
                          ...value?.config,
                          variableMapping:
                            Object.keys(nextMapping).length > 0 ? nextMapping : undefined,
                        },
                      });
                    }}
                  />
                ))}
              </div>
            )}
          </Field>
        </div>
      )}
      {kind === 'manual' && (
        <div className="text-sm text-neutral-500 dark:text-neutral-400">
          This workflow can only be run on demand from the UI or API.
        </div>
      )}
    </div>
  );
}

// Local row with internal text state so we only commit on blur — avoids
// flooding parent state (and re-rendering the whole form) on every keystroke.
function PayloadMappingRow({
  varName,
  def,
  initialValue,
  onCommit,
}: {
  varName: string;
  def: VariableDefinition;
  initialValue: string;
  onCommit: (next: string) => void;
}) {
  // We intentionally avoid useEffect-sync: parent updates only happen on blur,
  // so initialValue is a stable starting point per row.
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 w-40 shrink-0">
        <span className="font-mono text-xs text-foreground truncate">{varName}</span>
        <Badge variant="secondary">{def.type}</Badge>
      </div>
      <input
        type="text"
        defaultValue={initialValue}
        onBlur={(e) => onCommit(e.target.value)}
        placeholder="$.payload.path"
        className={INPUT_BASE + ' font-mono'}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-neutral-500 dark:text-neutral-400 tracking-wider mb-1">
        {label.toUpperCase()}
      </div>
      {children}
    </div>
  );
}

function defaultConfig(k: 'schedule' | 'webhook' | 'manual'): Record<string, unknown> {
  if (k === 'schedule') {
    return { cron: '0 9 * * *', timezone: 'America/Los_Angeles', target: 'workflow' };
  }
  if (k === 'webhook') {
    return { path: '', method: 'POST' };
  }
  return {};
}
