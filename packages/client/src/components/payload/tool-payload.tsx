/**
 * Shared payload renderer.
 *
 * Renders any structured value as one of three views:
 *   • Pretty-printed, syntax-highlighted JSON (default fallback)
 *   • Sortable / scrollable table (when the value is an array of
 *     homogeneous flat objects)
 *   • Clean preformatted text block (when the value is a multi-line
 *     string we couldn't decode further)
 *
 * Originally lived in `chat/tool-cards/generic-card.tsx`; lifted here
 * so the workflow trace card can use the exact same renderer instead
 * of its own nested KV grid. One payload UI, two consumers.
 */
import { Fragment, useState, type ReactNode } from 'react';
import { decode as decodeToon } from '@toon-format/toon';

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function tryParseJson(value: unknown): unknown | null {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    try {
      return decodeToon(value);
    } catch {
      return null;
    }
  }
}

function normalisePayload(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (looksEncoded(trimmed)) {
      const decoded = tryParseJson(trimmed);
      if (decoded !== null && decoded !== trimmed) {
        return normalisePayload(decoded);
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalisePayload);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalisePayload(v);
    }
    return out;
  }
  return value;
}

function looksEncoded(trimmed: string): boolean {
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '{' && last === '}') || (first === '[' && last === ']')) return true;
  if (first === '[' && /^\[\d+\][^\n]*:/.test(trimmed)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

const INDENT = '  ';
const URL_REGEX = /https?:\/\/[^\s"'<>)]+/g;
const MAX_CHARS = 3000;

export function ToolPayload({ value }: { value: unknown }) {
  const normalised = normalisePayload(value);
  const tableRows = detectTableRows(normalised);
  const [mode, setMode] = useState<'table' | 'json'>(tableRows ? 'table' : 'json');

  if (typeof normalised === 'string' && normalised.includes('\n')) {
    return <RawTextBlock text={normalised} />;
  }

  if (tableRows) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
            {tableRows.length} row{tableRows.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={() => setMode(mode === 'table' ? 'json' : 'table')}
            className="text-[11px] text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            {mode === 'table' ? 'JSON' : 'Table'}
          </button>
        </div>
        {mode === 'table' ? <TableRenderer data={tableRows} /> : <JsonBlock value={normalised} />}
      </div>
    );
  }

  return <JsonBlock value={normalised} />;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function RawTextBlock({ text }: { text: string }) {
  const [showAll, setShowAll] = useState(text.length <= MAX_CHARS);
  const display = showAll ? text : text.slice(0, MAX_CHARS) + '\n…';
  return (
    <div className="relative space-y-1.5">
      <CopyButton getText={() => text} />
      <pre className="m-0 max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-neutral-50/60 px-3 py-2.5 pr-12 font-mono text-[11.5px] leading-[1.65] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950/40 dark:text-neutral-200">
        {display}
      </pre>
      {!showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-[11px] text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          Show all ({text.length.toLocaleString()} chars)
        </button>
      )}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const approxSize = approxJsonSize(value);
  const [showAll, setShowAll] = useState(approxSize <= MAX_CHARS);
  return (
    <div className="relative space-y-1.5">
      <CopyButton getText={() => safeJsonString(value)} />
      <pre className="m-0 max-h-[480px] overflow-auto rounded-md border border-neutral-200 bg-neutral-50/60 px-3 py-2.5 pr-12 font-mono text-[11.5px] leading-[1.65] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950/40 dark:text-neutral-200">
        <JsonNode value={value} indent={0} budget={{ remaining: showAll ? Infinity : MAX_CHARS }} />
      </pre>
      {!showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-[11px] text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          Show all (~{approxSize.toLocaleString()} chars)
        </button>
      )}
    </div>
  );
}

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function approxJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value, null, 2).length;
  } catch {
    return 0;
  }
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="absolute right-1.5 top-1.5 z-10 rounded border border-neutral-200 bg-white/80 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-white hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
      title="Copy"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function detectTableRows(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows = value.filter(
    (v): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v),
  );
  if (rows.length !== value.length || rows.length < 1) return null;

  const allKeys = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) allKeys.add(k);
  if (allKeys.size === 0 || allKeys.size > 12) return null;

  const threshold = Math.max(1, Math.floor(allKeys.size * 0.5));
  const uniform = rows.every((row) => Object.keys(row).length >= threshold);
  return uniform ? rows : null;
}

const TABLE_PRIORITY = ['name', 'title', 'id', 'tool_id', 'label', 'slug', 'type', 'status', 'description', 'risk', 'risk_level', 'key', 'value'];

function selectColumns(rows: Record<string, unknown>[], maxCols = 6): { visible: string[]; hidden: string[] } {
  const allKeys = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) allKeys.add(k);
  const nonEmpty = [...allKeys].filter((key) =>
    rows.some((row) => row[key] != null && row[key] !== ''),
  );
  const sorted = nonEmpty.sort((a, b) => {
    const ai = TABLE_PRIORITY.indexOf(a.toLowerCase());
    const bi = TABLE_PRIORITY.indexOf(b.toLowerCase());
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });
  return { visible: sorted.slice(0, maxCols), hidden: sorted.slice(maxCols) };
}

function TableRenderer({ data }: { data: Record<string, unknown>[] }) {
  const MAX_ROWS = 25;
  const displayRows = data.slice(0, MAX_ROWS);
  const { visible, hidden } = selectColumns(data);

  if (visible.length === 0) return <JsonBlock value={data} />;

  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="max-h-[480px] overflow-auto">
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 z-10 bg-neutral-50 dark:bg-neutral-900">
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              {visible.map((col) => (
                <th key={col} className="whitespace-nowrap px-2 py-1.5 text-left text-[9.5px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {col}
                </th>
              ))}
              {hidden.length > 0 && (
                <th className="whitespace-nowrap px-2 py-1.5 text-left text-[9.5px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                  +{hidden.length}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr key={i} className={i % 2 === 1 ? 'bg-neutral-50/40 dark:bg-neutral-900/30' : ''}>
                {visible.map((col) => (
                  <td key={col} className="max-w-[280px] truncate px-2 py-1 text-neutral-700 dark:text-neutral-300" title={formatCellTitle(row[col])}>
                    <CellInline value={row[col]} />
                  </td>
                ))}
                {hidden.length > 0 && (
                  <td className="px-2 py-1 text-neutral-300 dark:text-neutral-600">…</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.length > MAX_ROWS && (
        <div className="border-t border-neutral-200 bg-neutral-50 px-2 py-1 text-[10px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          +{data.length - MAX_ROWS} more rows
        </div>
      )}
    </div>
  );
}

function CellInline({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-neutral-300 dark:text-neutral-600">—</span>;
  if (typeof value === 'boolean') {
    return <span className={value ? 'text-violet-600 dark:text-violet-400' : 'text-neutral-400'}>{String(value)}</span>;
  }
  if (typeof value === 'number') return <span className="tabular-nums text-violet-600 dark:text-violet-400">{value}</span>;
  if (typeof value === 'object') {
    const s = JSON.stringify(value);
    return <span className="text-neutral-400">{s.length > 60 ? s.slice(0, 60) + '…' : s}</span>;
  }
  return <span>{String(value)}</span>;
}

function formatCellTitle(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// JSON tree
// ---------------------------------------------------------------------------

interface Budget {
  remaining: number;
}

function JsonNode({ value, indent, budget }: { value: unknown; indent: number; budget: Budget }): ReactNode {
  if (value === null) return <span className="text-neutral-400 italic">null</span>;
  if (value === undefined) return <span className="text-neutral-400 italic">undefined</span>;
  if (typeof value === 'boolean') {
    return <span className="text-violet-600 dark:text-violet-400">{String(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="text-violet-600 dark:text-violet-400">{value}</span>;
  }
  if (typeof value === 'string') {
    return <JsonString value={value} indent={indent} budget={budget} />;
  }
  if (Array.isArray(value)) {
    return <JsonArray items={value} indent={indent} budget={budget} />;
  }
  if (typeof value === 'object') {
    return <JsonObject object={value as Record<string, unknown>} indent={indent} budget={budget} />;
  }
  return <span>{String(value)}</span>;
}

function JsonObject({ object, indent, budget }: { object: Record<string, unknown>; indent: number; budget: Budget }) {
  const entries = Object.entries(object);
  if (entries.length === 0) {
    return <span className="text-neutral-400">{'{}'}</span>;
  }
  const childPad = INDENT.repeat(indent + 1);
  const closePad = INDENT.repeat(indent);
  return (
    <>
      {'{'}
      {entries.map(([key, val], i) => {
        if (budget.remaining <= 0) return <Fragment key={key}></Fragment>;
        return (
          <Fragment key={key}>
            {'\n'}
            {childPad}
            <span className="text-neutral-500 dark:text-neutral-400">&quot;{key}&quot;</span>
            {': '}
            <JsonNode value={val} indent={indent + 1} budget={budget} />
            {i < entries.length - 1 ? ',' : ''}
          </Fragment>
        );
      })}
      {budget.remaining <= 0 && <span className="text-neutral-400">{`\n${childPad}…`}</span>}
      {'\n'}
      {closePad}
      {'}'}
    </>
  );
}

function JsonArray({ items, indent, budget }: { items: unknown[]; indent: number; budget: Budget }) {
  if (items.length === 0) return <span className="text-neutral-400">[]</span>;
  const childPad = INDENT.repeat(indent + 1);
  const closePad = INDENT.repeat(indent);
  return (
    <>
      {'['}
      {items.map((item, i) => {
        if (budget.remaining <= 0) return <Fragment key={i}></Fragment>;
        return (
          <Fragment key={i}>
            {'\n'}
            {childPad}
            <JsonNode value={item} indent={indent + 1} budget={budget} />
            {i < items.length - 1 ? ',' : ''}
          </Fragment>
        );
      })}
      {budget.remaining <= 0 && <span className="text-neutral-400">{`\n${childPad}…`}</span>}
      {'\n'}
      {closePad}
      {']'}
    </>
  );
}

function JsonString({ value, indent, budget }: { value: string; indent: number; budget: Budget }) {
  budget.remaining -= value.length + 2;
  const STR = 'text-emerald-700 dark:text-emerald-400';
  if (value.includes('\n')) {
    const childPad = INDENT.repeat(indent + 1);
    const lines = value.split('\n');
    return (
      <span className={STR}>
        &quot;
        {lines.map((line, i) => (
          <Fragment key={i}>
            <LinkifiedSpan text={line} />
            {i < lines.length - 1 ? `\n${childPad}` : ''}
          </Fragment>
        ))}
        &quot;
      </span>
    );
  }
  return (
    <span className={STR}>
      &quot;
      <LinkifiedSpan text={value} />
      &quot;
    </span>
  );
}

function LinkifiedSpan({ text }: { text: string }) {
  const matches = [...text.matchAll(URL_REGEX)];
  if (matches.length === 0) return <>{text}</>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, i) => {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(<Fragment key={`t${i}`}>{text.slice(cursor, start)}</Fragment>);
    const url = match[0];
    parts.push(
      <a
        key={`u${i}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-500 underline-offset-2 hover:underline dark:text-blue-400"
      >
        {url}
      </a>
    );
    cursor = start + url.length;
  });
  if (cursor < text.length) parts.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}

export { tryParseJson };
