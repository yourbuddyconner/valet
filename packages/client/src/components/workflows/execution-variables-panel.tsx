interface Props {
  outputs?: Record<string, unknown> | string | null;
}

export function ExecutionVariablesPanel({ outputs }: Props) {
  const entries = normalize(outputs);
  if (!entries) {
    return <div className="text-xs text-neutral-500">No variables yet.</div>;
  }
  if (entries === 'raw' && typeof outputs === 'string') {
    return (
      <pre className="font-mono text-xs bg-neutral-50 border border-neutral-200 rounded-lg p-2.5 whitespace-pre-wrap break-words">
        {outputs}
      </pre>
    );
  }
  return (
    <div className="font-mono text-xs bg-neutral-50 border border-neutral-200 rounded-lg p-2.5">
      {(entries as Array<[string, unknown]>).map(([k, v]) => (
        <div key={k} className="truncate">
          <span className="text-neutral-500">{k}:</span> {summarize(v)}
        </div>
      ))}
    </div>
  );
}

// The server stores outputs as JSON; usually that's an object keyed by step.outputVariable,
// but a workflow that produces a single scalar can end up with a JSON string. Iterating a
// raw string via Object.entries enumerates its characters, which is what we want to avoid.
function normalize(outputs: Props['outputs']): Array<[string, unknown]> | 'raw' | null {
  if (outputs == null) return null;
  if (typeof outputs === 'string') {
    return outputs.length === 0 ? null : 'raw';
  }
  if (typeof outputs !== 'object' || Array.isArray(outputs)) return 'raw';
  const entries = Object.entries(outputs);
  return entries.length === 0 ? null : entries;
}

function summarize(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  } catch {
    return String(v);
  }
}
