import { memo } from 'react';
import { decode as decodeToon } from '@toon-format/toon';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ToolCardShell, ToolCardSection, ToolCodeBlock } from './tool-card-shell';
import { WrenchIcon } from './icons';
import type { ToolCallData } from './types';

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function tryParseJson(value: unknown): unknown | null {
  if (value == null) return null;
  if (typeof value === 'object') return value; // already parsed object/array
  if (typeof value === 'boolean' || typeof value === 'number') return value; // already primitives
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    // Tool results may be TOON-encoded (token-efficient format used for LLM context)
    try {
      return decodeToon(value);
    } catch {
      return null;
    }
  }
}

type Shape = 'table' | 'kv' | 'scalar' | 'json';

function detectShape(data: unknown): Shape {
  if (data == null || typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return 'scalar';
  }

  if (Array.isArray(data)) {
    // Need 2+ object items where each has ≥50% of the union key set
    const objects = data.filter((d): d is Record<string, unknown> => d != null && typeof d === 'object' && !Array.isArray(d));
    if (objects.length >= 2) {
      const allKeys = new Set<string>();
      for (const obj of objects) {
        for (const k of Object.keys(obj)) allKeys.add(k);
      }
      const threshold = allKeys.size * 0.5;
      const uniform = objects.every((obj) => Object.keys(obj).length >= threshold);
      if (uniform) return 'table';
    }
    return 'json';
  }

  if (typeof data === 'object') {
    // Flat-ish object → kv
    const values = Object.values(data as Record<string, unknown>);
    const nestedCount = values.filter((v) => v != null && typeof v === 'object').length;
    // If more than half of the values are nested objects, treat as json
    if (values.length > 0 && nestedCount > values.length * 0.6) return 'json';
    return 'kv';
  }

  return 'json';
}

/** Pick the most meaningful columns for display, skipping all-null columns */
function selectColumns(rows: Record<string, unknown>[], maxCols: number = 8): { visible: string[]; hidden: string[] } {
  const allKeys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) allKeys.add(k);
  }

  // Filter out columns that are all null/undefined
  const nonEmpty = [...allKeys].filter((key) =>
    rows.some((row) => row[key] != null && row[key] !== ''),
  );

  // Prioritize common "name/id/title" keys first, then the rest
  const priority = ['name', 'title', 'id', 'label', 'description', 'type', 'status', 'slug', 'key', 'value', 'email', 'handle'];
  const sorted = nonEmpty.sort((a, b) => {
    const ai = priority.indexOf(a.toLowerCase());
    const bi = priority.indexOf(b.toLowerCase());
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });

  return {
    visible: sorted.slice(0, maxCols),
    hidden: sorted.slice(maxCols),
  };
}

// ---------------------------------------------------------------------------
// Value renderers
// ---------------------------------------------------------------------------

const CellValue = memo(function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-neutral-300 dark:text-neutral-600">&mdash;</span>;
  }
  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-400 dark:text-neutral-500'}>
        {value ? 'true' : 'false'}
      </span>
    );
  }
  if (typeof value === 'number') {
    return <span className="tabular-nums">{value}</span>;
  }
  if (typeof value === 'object') {
    const s = JSON.stringify(value);
    const display = s.length > 60 ? s.slice(0, 60) + '...' : s;
    return <span className="text-neutral-500 dark:text-neutral-500">{display}</span>;
  }
  const str = String(value);
  if (str.length > 80) {
    return <span>{str.slice(0, 80)}...</span>;
  }
  return <>{str}</>;
});

/** Format a value as a full string for tooltip display */
function formatFullValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return null; // not worth a tooltip
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  const str = String(value);
  return str.length > 30 ? str : null; // only tooltip for values that might be truncated
}

/** Wraps content in a Radix Tooltip showing the full value on hover */
function ValueTooltip({ value, children }: { value: unknown; children: React.ReactNode }) {
  const full = formatFullValue(value);
  if (!full) return <>{children}</>;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default">{children}</span>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          className="max-h-[300px] max-w-[480px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-neutral-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-100 shadow-lg dark:bg-neutral-800 dark:text-neutral-200"
        >
          {full}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Sub-renderers
// ---------------------------------------------------------------------------

function TableRenderer({ data }: { data: Record<string, unknown>[] }) {
  const maxRows = 20;
  const displayRows = data.slice(0, maxRows);
  const { visible, hidden } = selectColumns(data);

  if (visible.length === 0) {
    return <ToolCodeBlock>{JSON.stringify(data, null, 2)}</ToolCodeBlock>;
  }

  return (
    <div>
      <div className="overflow-x-auto" style={{ maxHeight: '280px' }}>
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead>
            <tr className="border-b border-neutral-150 dark:border-neutral-700/60">
              {visible.map((col) => (
                <th
                  key={col}
                  className="whitespace-nowrap px-2 py-1 text-left font-mono text-[9px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500"
                >
                  {col}
                </th>
              ))}
              {hidden.length > 0 && (
                <th className="whitespace-nowrap px-2 py-1 text-left font-mono text-[9px] font-medium uppercase tracking-wider text-neutral-300 dark:text-neutral-600">
                  +{hidden.length} more
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr
                key={i}
                className={
                  i % 2 === 1
                    ? 'bg-neutral-50/50 dark:bg-neutral-800/20'
                    : ''
                }
              >
                {visible.map((col) => (
                  <td
                    key={col}
                    className="max-w-[240px] truncate whitespace-nowrap px-2 py-0.5 text-neutral-600 dark:text-neutral-400"
                  >
                    <ValueTooltip value={row[col]}>
                      <CellValue value={row[col]} />
                    </ValueTooltip>
                  </td>
                ))}
                {hidden.length > 0 && (
                  <td className="px-2 py-0.5 text-neutral-300 dark:text-neutral-600">
                    &middot;&middot;&middot;
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.length > maxRows && (
        <div className="border-t border-neutral-100 px-2 py-1 font-mono text-[9px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
          +{data.length - maxRows} more rows
        </div>
      )}
    </div>
  );
}

function KvRenderer({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;

  return (
    <div className="overflow-auto font-mono text-[11px]" style={{ maxHeight: '280px' }}>
      <div className="space-y-0">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-3 px-0 py-0.5">
            <span className="shrink-0 text-neutral-400 dark:text-neutral-500" style={{ minWidth: '100px' }}>
              {key}
            </span>
            <span className="min-w-0 truncate text-neutral-600 dark:text-neutral-400">
              <ValueTooltip value={value}>
                <CellValue value={value} />
              </ValueTooltip>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ArgsRenderer({ args }: { args: unknown }) {
  const parsed = tryParseJson(args);
  if (parsed == null) return null;

  // If it's an object, render as kv
  if (typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return null;

    // Check if any value is very long (>200 chars) — fall back to code block
    const hasLong = entries.some(([, v]) => typeof v === 'string' && v.length > 200);
    if (hasLong) {
      const str = JSON.stringify(obj, null, 2);
      return <ToolCodeBlock maxHeight="160px">{str}</ToolCodeBlock>;
    }

    return <KvRenderer data={obj} />;
  }

  const str = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  return <ToolCodeBlock maxHeight="160px">{str}</ToolCodeBlock>;
}

function ResultRenderer({ result }: { result: unknown }) {
  const parsed = tryParseJson(result);

  // Unparseable — render raw string
  if (parsed == null) {
    const str = String(result);
    return (
      <ToolCodeBlock maxHeight="280px">
        {str.length > 4000 ? str.slice(0, 4000) + '\n... (truncated)' : str}
      </ToolCodeBlock>
    );
  }

  const shape = detectShape(parsed);

  switch (shape) {
    case 'table':
      return <TableRenderer data={parsed as Record<string, unknown>[]} />;

    case 'kv':
      return <KvRenderer data={parsed as Record<string, unknown>} />;

    case 'scalar': {
      const str = String(parsed);
      if (str.length > 200) {
        return <ToolCodeBlock maxHeight="280px">{str}</ToolCodeBlock>;
      }
      return (
        <div className="font-mono text-[11px] text-neutral-600 dark:text-neutral-400">
          <CellValue value={parsed} />
        </div>
      );
    }

    case 'json':
    default: {
      const str = JSON.stringify(parsed, null, 2);
      return (
        <ToolCodeBlock maxHeight="280px">
          {str.length > 4000 ? str.slice(0, 4000) + '\n... (truncated)' : str}
        </ToolCodeBlock>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

function extractSummary(tool: ToolCallData): string | null {
  const args = tool.args;
  const argsObj = typeof args === 'object' && args != null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null;

  // Special case: call_tool → show tool_id
  if (tool.toolName === 'call_tool' && argsObj?.tool_id) {
    return String(argsObj.tool_id);
  }

  // Try common arg fields for summary
  if (argsObj) {
    for (const key of ['description', 'command', 'file_path', 'filePath', 'path', 'pattern', 'query', 'message', 'url', 'name', 'tool_id']) {
      const val = argsObj[key];
      if (typeof val === 'string' && val.length > 0) {
        return val.length > 100 ? val.slice(0, 100) + '...' : val;
      }
    }
  }

  // Result-based summary
  const parsed = tryParseJson(tool.result);
  if (parsed != null) {
    if (Array.isArray(parsed)) {
      return `${parsed.length} item${parsed.length === 1 ? '' : 's'}`;
    }
    if (typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      // Try to show a meaningful field from the result
      for (const key of ['name', 'title', 'status', 'message', 'id']) {
        const val = obj[key];
        if (typeof val === 'string' && val.length > 0) {
          return val.length > 80 ? val.slice(0, 80) + '...' : val;
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GenericCard({ tool }: { tool: ToolCallData }) {
  const hasArgs = tool.args != null && (typeof tool.args !== 'object' || Object.keys(tool.args as object).length > 0);
  const hasResult = tool.result != null && tool.result !== '';

  const summary = extractSummary(tool);

  return (
    <ToolCardShell
      icon={<WrenchIcon className="h-3.5 w-3.5" />}
      label={tool.toolName}
      status={tool.status}
      summary={summary ? (
        <span className="text-neutral-500 dark:text-neutral-400">{summary}</span>
      ) : undefined}
    >
      {(hasArgs || hasResult) && (
        <>
          {hasArgs && (
            <ToolCardSection label="arguments">
              <ArgsRenderer args={tool.args} />
            </ToolCardSection>
          )}
          {hasResult && (
            <ToolCardSection label="result" className="border-t border-neutral-100 dark:border-neutral-800">
              <ResultRenderer result={tool.result} />
            </ToolCardSection>
          )}
        </>
      )}
    </ToolCardShell>
  );
}
