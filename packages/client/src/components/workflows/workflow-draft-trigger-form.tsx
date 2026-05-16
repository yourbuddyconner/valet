interface TriggerValue {
  kind: 'schedule' | 'webhook' | 'manual';
  config: Record<string, unknown>;
}

interface Props {
  value: TriggerValue | null;
  onChange: (v: TriggerValue | null) => void;
}

export function WorkflowDraftTriggerForm({ value, onChange }: Props) {
  const kind = value?.kind ?? 'manual';

  // Bridge from Record<string, unknown> index access to input default strings.
  const cron = typeof value?.config.cron === 'string' ? value.config.cron : '0 9 * * *';
  const timezone =
    typeof value?.config.timezone === 'string' ? value.config.timezone : 'America/Los_Angeles';
  const path = typeof value?.config.path === 'string' ? value.config.path : '';
  const method = typeof value?.config.method === 'string' ? value.config.method : 'POST';

  return (
    <div className="px-6 py-4 bg-white border-t border-neutral-200">
      <div className="text-sm font-semibold text-neutral-900 mb-2">How should this run?</div>
      <div className="flex gap-2 mb-3">
        {(['schedule', 'webhook', 'manual'] as const).map((k) => (
          <button
            key={k}
            onClick={() => onChange({ kind: k, config: defaultConfig(k) })}
            aria-pressed={kind === k}
            className={
              'text-xs px-3 py-1 rounded-full border ' +
              (kind === k
                ? 'bg-neutral-900 text-white border-neutral-900'
                : 'bg-white text-neutral-700 border-neutral-300')
            }
          >
            {k}
          </button>
        ))}
      </div>
      {kind === 'schedule' && (
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500">Cron</span>
            <input
              type="text"
              value={cron}
              onChange={(e) =>
                onChange({ kind: 'schedule', config: { ...value?.config, cron: e.target.value } })
              }
              className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm font-mono"
            />
          </label>
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500">Timezone</span>
            <input
              type="text"
              value={timezone}
              onChange={(e) =>
                onChange({
                  kind: 'schedule',
                  config: { ...value?.config, timezone: e.target.value },
                })
              }
              className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>
        </div>
      )}
      {kind === 'webhook' && (
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500">Path</span>
            <input
              type="text"
              value={path}
              onChange={(e) =>
                onChange({ kind: 'webhook', config: { ...value?.config, path: e.target.value } })
              }
              placeholder="my-workflow"
              className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm font-mono"
            />
          </label>
          <label className="text-xs">
            <span className="block mb-1 text-neutral-500">Method</span>
            <select
              value={method}
              onChange={(e) =>
                onChange({ kind: 'webhook', config: { ...value?.config, method: e.target.value } })
              }
              className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
            >
              <option>POST</option>
              <option>GET</option>
            </select>
          </label>
        </div>
      )}
      {kind === 'manual' && (
        <div className="text-sm text-neutral-500">
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
