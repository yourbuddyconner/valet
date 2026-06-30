import { Fragment, useState, type ReactNode } from 'react';
import { decode as decodeToon } from '@toon-format/toon';
import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { WrenchIcon } from './icons';
import type { ToolCallData } from './types';

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
    // Tool results may be TOON-encoded (token-efficient format used for
    // LLM context). Fall back to decoding before giving up.
    try {
      return decodeToon(value);
    } catch {
      return null;
    }
  }
}

/**
 * Walk a parsed payload and one-level-unwrap any string values that
 * look like JSON-encoded objects/arrays. This is the common case where
 * a tool serialises a sub-payload as a string (e.g. `call_tool`'s
 * `params` field). We only unwrap obvious cases (`{...}` or `[...]`),
 * not free-text that happens to contain brackets.
 */
function normalisePayload(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
      const first = trimmed[0];
      const last = trimmed[trimmed.length - 1];
      if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
        try {
          return normalisePayload(JSON.parse(trimmed));
        } catch {
          /* fall through */
        }
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalisePayload);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalisePayload(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// JSON renderer
//
// The body of every tool card is just pretty-printed JSON with subtle
// syntax highlighting. One column. Predictable. Copy-pasteable.
// Multi-line strings are rendered in place with proper indentation
// (newlines preserved, not escaped). URLs are clickable.
// ---------------------------------------------------------------------------

const INDENT = '  ';
const URL_REGEX = /https?:\/\/[^\s"'<>)]+/g;
const MAX_CHARS = 3000;

export function ToolPayload({ value }: { value: unknown }) {
  const normalised = normalisePayload(value);
  const approxSize = approxJsonSize(normalised);
  const [showAll, setShowAll] = useState(approxSize <= MAX_CHARS);

  return (
    <div className="space-y-1.5">
      <pre className="m-0 max-h-[480px] overflow-auto rounded-md border border-neutral-200 bg-neutral-50/60 px-3 py-2.5 font-mono text-[11.5px] leading-[1.65] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950/40 dark:text-neutral-200">
        <JsonNode value={normalised} indent={0} budget={{ remaining: showAll ? Infinity : MAX_CHARS }} />
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
  // Spend the value's approximate cost from the budget. The pretty
  // multi-line string roughly counts as one char per output char.
  budget.remaining -= value.length + 2;

  const STR = 'text-emerald-700 dark:text-emerald-400';

  // Multi-line string: indent every subsequent line so the JSON layout
  // stays readable. The opening quote sits where the value would; the
  // closing quote lands on its own line at the parent indent + 1 so it
  // visually closes the value.
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

/** Inline render that turns embedded http(s) URLs into clickable links. */
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

/** Cheap estimate of pretty-printed size; used to gate the show-all toggle. */
function approxJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value, null, 2).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Summary extraction (collapsed-state header)
// ---------------------------------------------------------------------------

function extractSummary(tool: ToolCallData): string | null {
  const args = tool.args;
  const argsObj = typeof args === 'object' && args != null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null;

  if (tool.toolName === 'call_tool' && argsObj?.tool_id) {
    return String(argsObj.tool_id);
  }

  if (argsObj) {
    for (const key of ['description', 'command', 'file_path', 'filePath', 'path', 'pattern', 'query', 'message', 'url', 'name', 'tool_id']) {
      const val = argsObj[key];
      if (typeof val === 'string' && val.length > 0) {
        return val.length > 100 ? val.slice(0, 100) + '…' : val;
      }
    }
  }

  const parsed = tryParseJson(tool.result);
  if (parsed != null) {
    if (Array.isArray(parsed)) {
      return `${parsed.length} item${parsed.length === 1 ? '' : 's'}`;
    }
    if (typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['name', 'title', 'status', 'message', 'id']) {
        const val = obj[key];
        if (typeof val === 'string' && val.length > 0) {
          return val.length > 80 ? val.slice(0, 80) + '…' : val;
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Card
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
      result={tool.result}
      summary={summary ? (
        <span className="text-neutral-500 dark:text-neutral-400">{summary}</span>
      ) : undefined}
    >
      {(hasArgs || hasResult) && (
        <>
          {hasArgs && (
            <ToolCardSection label="arguments">
              <ToolPayload value={tool.args} />
            </ToolCardSection>
          )}
          {hasResult && (
            <ToolCardSection label="result" className="border-t border-neutral-100 dark:border-neutral-800">
              <ToolPayload value={tryParseJson(tool.result) ?? tool.result} />
            </ToolCardSection>
          )}
        </>
      )}
    </ToolCardShell>
  );
}
