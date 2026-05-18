interface TriggerValue {
  kind: 'schedule' | 'webhook' | 'manual';
  config: Record<string, unknown>;
}

interface Props {
  value: TriggerValue | null;
  onChange: (v: TriggerValue | null) => void;
}

// Reused input styling — surface tokens, accent focus ring, dark-mode safe.
const INPUT_BASE =
  'w-full rounded-md border border-border bg-surface-0 dark:bg-surface-2 text-foreground px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition';

export function WorkflowDraftTriggerForm({ value, onChange }: Props) {
  const kind = value?.kind ?? 'manual';

  // Bridge from Record<string, unknown> index access to input default strings.
  const cron = typeof value?.config.cron === 'string' ? value.config.cron : '0 9 * * *';
  const timezone =
    typeof value?.config.timezone === 'string' ? value.config.timezone : 'America/Los_Angeles';
  const path = typeof value?.config.path === 'string' ? value.config.path : '';
  const method = typeof value?.config.method === 'string' ? value.config.method : 'POST';

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
      )}
      {kind === 'manual' && (
        <div className="text-sm text-neutral-500 dark:text-neutral-400">
          This workflow can only be run on demand from the UI or API.
        </div>
      )}
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
