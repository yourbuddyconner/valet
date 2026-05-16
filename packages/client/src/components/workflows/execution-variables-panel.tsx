import { useState } from 'react';

interface Props {
  outputs?: Record<string, unknown> | string | null;
}

export function ExecutionVariablesPanel({ outputs }: Props) {
  const entries = normalize(outputs);
  if (entries === 'empty') {
    return <div className="text-xs text-neutral-500">No outputs captured.</div>;
  }
  if (entries === 'raw' && typeof outputs === 'string') {
    return <RawBlock text={outputs} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {(entries as Array<[string, unknown]>).map(([k, v]) => (
        <OutputEntry key={k} name={k} value={v} />
      ))}
    </div>
  );
}

function OutputEntry({ name, value }: { name: string; value: unknown }) {
  // Auto-expand objects and arrays — they're the main payload of agent_prompt
  // outputs and users almost always want to see the contents at a glance.
  const initiallyExpanded = typeOf(value) === 'object' || typeOf(value) === 'array';
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const summary = formatSummary(value);
  const full = formatFull(value);
  const isExpandable = full !== summary || full.includes('\n');

  return (
    <div className="border border-neutral-200 rounded-lg bg-neutral-50 overflow-hidden">
      <button
        type="button"
        onClick={() => isExpandable && setExpanded((v) => !v)}
        className={
          'w-full flex items-center gap-2 px-2.5 py-1.5 text-left ' +
          (isExpandable ? 'cursor-pointer hover:bg-neutral-100' : 'cursor-default')
        }
        aria-expanded={isExpandable ? expanded : undefined}
        disabled={!isExpandable}
      >
        <span className="font-mono text-xs font-semibold text-neutral-900">{name}</span>
        <TypeBadge value={value} />
        {isExpandable && (
          <span className="ml-auto text-[10px] text-neutral-500">{expanded ? '▾' : '▸'}</span>
        )}
      </button>
      {!expanded && (
        <div className="px-2.5 pb-1.5 font-mono text-xs text-neutral-700 truncate">{summary}</div>
      )}
      {expanded && (
        <pre className="px-2.5 pb-2 font-mono text-xs text-neutral-800 whitespace-pre-wrap break-words border-t border-neutral-200 pt-2 bg-white">
          {full}
        </pre>
      )}
    </div>
  );
}

function TypeBadge({ value }: { value: unknown }) {
  const t = typeOf(value);
  const cls =
    t === 'string'
      ? 'bg-emerald-50 text-emerald-700'
      : t === 'number' || t === 'boolean'
        ? 'bg-blue-50 text-blue-700'
        : t === 'array'
          ? 'bg-fuchsia-50 text-fuchsia-700'
          : t === 'object'
            ? 'bg-amber-50 text-amber-800'
            : 'bg-neutral-100 text-neutral-600';
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${cls}`}>{t}</span>
  );
}

function RawBlock({ text }: { text: string }) {
  return (
    <pre className="font-mono text-xs bg-neutral-50 border border-neutral-200 rounded-lg p-2.5 whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

// 'empty' when there's nothing to show; 'raw' when outputs is a non-object scalar
// or array we should dump as-is; otherwise an array of [name, value] entries.
function normalize(outputs: Props['outputs']): Array<[string, unknown]> | 'raw' | 'empty' {
  if (outputs == null) return 'empty';
  if (typeof outputs === 'string') return outputs.length === 0 ? 'empty' : 'raw';
  if (typeof outputs !== 'object' || Array.isArray(outputs)) return 'raw';
  const entries = Object.entries(outputs);
  return entries.length === 0 ? 'empty' : entries;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatSummary(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'string') {
    return value.length > 120 ? value.slice(0, 117) + '…' : value;
  }
  try {
    const compact = JSON.stringify(value);
    return compact.length > 120 ? compact.slice(0, 117) + '…' : compact;
  } catch {
    return String(value);
  }
}

function formatFull(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
