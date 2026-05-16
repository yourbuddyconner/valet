interface Props {
  outputs?: Record<string, unknown> | null;
}

export function ExecutionVariablesPanel({ outputs }: Props) {
  if (!outputs || Object.keys(outputs).length === 0) {
    return <div className="text-xs text-neutral-500">No variables yet.</div>;
  }
  return (
    <div className="font-mono text-xs bg-neutral-50 border border-neutral-200 rounded-lg p-2.5">
      {Object.entries(outputs).map(([k, v]) => (
        <div key={k} className="truncate">
          <span className="text-neutral-500">{k}:</span> {summarize(v)}
        </div>
      ))}
    </div>
  );
}

function summarize(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  } catch {
    return String(v);
  }
}
