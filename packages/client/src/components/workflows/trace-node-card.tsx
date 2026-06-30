import * as React from 'react';
import type { Execution, ExecutionNode } from '@/api/executions';
import { Badge } from '@/components/ui/badge';
import { MarkdownContent } from '@/components/chat/markdown/markdown-content';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { correctNodeStatusForFinishedExecution } from './workflow-execution-viewer-model';

// ─── Public ──────────────────────────────────────────────────────────────────

export function TraceNodeCard({
  node,
  executionStatus,
  defaultOpen,
}: {
  node: ExecutionNode;
  executionStatus: Execution['status'];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const corrected = correctNodeStatusForFinishedExecution(node.status, executionStatus);
  const status = corrected === 'not_run' ? node.status : corrected;
  const output = useParsedPayload(node.output);
  const input = useParsedPayload(node.inputPreview);
  const summary = describeNodeOutcome(node, output);
  const isError = status === 'failed' || !!node.error;

  return (
    <div className={cn(
      'overflow-hidden rounded-lg border bg-white transition-shadow dark:bg-neutral-900',
      open && 'shadow-sm',
      isError
        ? 'border-red-200 dark:border-red-900/50'
        : 'border-neutral-200 dark:border-neutral-800',
    )}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center text-neutral-400">
          {open ? '▾' : '▸'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-xs font-medium text-neutral-900 dark:text-neutral-100">
              {node.nodeId}
            </span>
            <Badge variant="secondary" className="shrink-0">{node.nodeType}</Badge>
            <StatusPill status={status} />
            {node.retryAttempts > 0 && (
              <Badge variant="warning" className="shrink-0">retry ×{node.retryAttempts}</Badge>
            )}
          </div>
          {summary && (
            <p className={cn(
              'mt-1 text-xs',
              isError ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-300',
              open ? 'whitespace-pre-wrap' : 'truncate',
            )}>
              {summary}
            </p>
          )}
        </div>
        <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {typeof node.durationMs === 'number' ? formatDuration(node.durationMs) : '—'}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-neutral-200 px-4 py-4 dark:border-neutral-800">
          {node.error && (
            <Section title="Error" tone="error">
              <ErrorBlock value={node.error} />
            </Section>
          )}
          <NodeBody node={node} output={output} />
          {input !== undefined && input !== null && (
            <CollapsibleSection title={node.inputTruncated ? 'Input (truncated)' : 'Input'}>
              <SmartValue value={input} />
            </CollapsibleSection>
          )}
          <RawJsonFooter output={node.output} input={node.inputPreview} error={node.error} reason={node.reason} />
        </div>
      )}
    </div>
  );
}

// ─── Per-node-type body picker ───────────────────────────────────────────────

function NodeBody({ node, output }: { node: ExecutionNode; output: unknown }) {
  if (output === null || output === undefined) {
    if (node.reason) {
      return (
        <Section title="Reason"><span className="text-sm text-neutral-700 dark:text-neutral-300">{node.reason}</span></Section>
      );
    }
    return null;
  }

  switch (node.nodeType) {
    case 'trigger': return <TriggerBody output={output} />;
    case 'set': return <SetBody output={output} />;
    case 'if': return <IfBody output={output} />;
    case 'llm': return <LlmBody output={output} />;
    case 'tool': return <ToolBody output={output} />;
    case 'wait': return <WaitBody output={output} />;
    case 'approval': return <ApprovalBody output={output} />;
    case 'foreach': return <ForeachBody output={output} />;
    case 'session':
    case 'orchestrator': return <SessionBody output={output} />;
    case 'stop': return <StopBody output={output} />;
    default:
      return (
        <Section title="Output"><SmartValue value={output} /></Section>
      );
  }
}

// ─── Node-type bodies ────────────────────────────────────────────────────────

function TriggerBody({ output }: { output: unknown }) {
  const o = asObject(output);
  if (!o) return <Section title="Output"><SmartValue value={output} /></Section>;
  const data = o.data;
  const metadata = asObject(o.metadata) ?? {};
  return (
    <>
      {data !== undefined && data !== null && (
        <Section title="Trigger data"><SmartValue value={data} /></Section>
      )}
      {Object.keys(metadata).length > 0 && (
        <CollapsibleSection title="Metadata"><KeyValueGrid value={metadata} /></CollapsibleSection>
      )}
    </>
  );
}

function SetBody({ output }: { output: unknown }) {
  return <Section title="Values"><SmartValue value={output} /></Section>;
}

function IfBody({ output }: { output: unknown }) {
  const o = asObject(output);
  if (!o) return <Section title="Output"><SmartValue value={output} /></Section>;
  const result = o.result === true;
  const matched = Array.isArray(o.matched) ? o.matched : [];
  return (
    <Section title="Branch">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={result ? 'success' : 'secondary'}>{result ? 'true' : 'false'}</Badge>
        <span className="text-neutral-500 dark:text-neutral-400">
          {matched.length} condition{matched.length === 1 ? '' : 's'} matched
        </span>
        {typeof o.combinator === 'string' && (
          <span className="text-xs text-neutral-400">combinator: {o.combinator}</span>
        )}
      </div>
    </Section>
  );
}

function LlmBody({ output }: { output: unknown }) {
  // LLM output is most often a long string. Show it as a quoted block
  // with show-more — way more useful than a JSON dump.
  const o = asObject(output);
  const text = typeof o?.response === 'string'
    ? o.response
    : typeof output === 'string'
      ? output
      : null;
  if (text) {
    return (
      <Section title="Generated">
        <RichText text={text} />
      </Section>
    );
  }
  return <Section title="Output"><SmartValue value={output} /></Section>;
}

function ToolBody({ output }: { output: unknown }) {
  const o = asObject(output);
  if (!o) return <Section title="Result"><SmartValue value={output} /></Section>;
  // Most tool outputs are flat objects. Promote a top-level URL if
  // present (Drive create_document → url; sheets updates → updatedRange);
  // render the rest as a key-value grid.
  return <Section title="Result"><KeyValueGrid value={o} /></Section>;
}

function WaitBody({ output }: { output: unknown }) {
  const o = asObject(output);
  if (!o) return null;
  return <Section title="Wait"><KeyValueGrid value={o} /></Section>;
}

function ApprovalBody({ output }: { output: unknown }) {
  const o = asObject(output);
  if (!o) return null;
  const approved = o.approved === true;
  return (
    <Section title="Decision">
      <div className="space-y-1 text-sm">
        <div className="flex items-center gap-2">
          <Badge variant={approved ? 'success' : 'error'}>{approved ? 'Approved' : 'Denied'}</Badge>
          {typeof o.approvedBy === 'string' && (
            <span className="font-mono text-xs text-neutral-500">by {o.approvedBy}</span>
          )}
          {typeof o.respondedAt === 'string' && (
            <span className="text-xs text-neutral-500">{formatRelativeTime(o.respondedAt)}</span>
          )}
        </div>
        {typeof o.reason === 'string' && o.reason && (
          <p className="text-neutral-600 dark:text-neutral-400">{o.reason}</p>
        )}
      </div>
    </Section>
  );
}

function ForeachBody({ output }: { output: unknown }) {
  const o = asObject(output);
  if (!o) return <Section title="Output"><SmartValue value={output} /></Section>;
  const inputCount = typeof o.inputCount === 'number' ? o.inputCount : null;
  const completedCount = typeof o.completedCount === 'number' ? o.completedCount : null;
  const failedCount = typeof o.failedCount === 'number' ? o.failedCount : 0;
  const skippedCount = typeof o.skippedCount === 'number' ? o.skippedCount : 0;
  const truncatedCount = typeof o.truncatedCount === 'number' ? o.truncatedCount : 0;
  return (
    <Section title="Iterations">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {completedCount !== null && (
          <Badge variant="success">{completedCount} completed</Badge>
        )}
        {failedCount > 0 && <Badge variant="error">{failedCount} failed</Badge>}
        {skippedCount > 0 && <Badge variant="secondary">{skippedCount} skipped</Badge>}
        {truncatedCount > 0 && <Badge variant="warning">{truncatedCount} truncated</Badge>}
        {inputCount !== null && completedCount !== null && completedCount < inputCount && (
          <span className="text-xs text-neutral-500">of {inputCount} input{inputCount === 1 ? '' : 's'}</span>
        )}
      </div>
    </Section>
  );
}

function SessionBody({ output }: { output: unknown }) {
  const o = asObject(output);
  if (!o) return <Section title="Output"><SmartValue value={output} /></Section>;
  const sessionId = typeof o.sessionId === 'string' ? o.sessionId : null;
  const finalStatus = typeof o.finalStatus === 'string' ? o.finalStatus : null;
  const lastMessage = asObject(o.lastMessage);
  const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : null;
  return (
    <>
      <Section title="Session">
        <div className="space-y-1.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {finalStatus && (
              <Badge variant={finalStatus === 'completed' ? 'success' : 'secondary'}>{finalStatus}</Badge>
            )}
            {sessionId && (
              <a
                href={`/sessions/${sessionId}`}
                className="font-mono text-xs text-violet-600 underline hover:text-violet-800 dark:text-violet-400 dark:hover:text-violet-300"
              >
                {sessionId.slice(0, 8)}…
              </a>
            )}
          </div>
        </div>
      </Section>
      {lastContent && (
        <Section title="Last message">
          <RichText text={lastContent} />
        </Section>
      )}
    </>
  );
}

function StopBody({ output }: { output: unknown }) {
  const o = asObject(output);
  if (!o) return <Section title="Output"><SmartValue value={output} /></Section>;
  const outcome = typeof o.outcome === 'string' ? o.outcome : null;
  const message = typeof o.message === 'string' ? o.message : null;
  return (
    <>
      <Section title="Outcome">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {outcome && (
            <Badge variant={outcome === 'success' ? 'success' : outcome === 'failure' ? 'error' : 'secondary'}>
              {outcome}
            </Badge>
          )}
          {message && <span className="text-neutral-700 dark:text-neutral-300">{message}</span>}
        </div>
      </Section>
      {o.output !== undefined && o.output !== null && (
        <Section title="Output"><SmartValue value={o.output} /></Section>
      )}
    </>
  );
}

// ─── Reusable primitives ─────────────────────────────────────────────────────

function Section({
  title,
  tone = 'neutral',
  children,
}: {
  title: string;
  tone?: 'neutral' | 'error';
  children: React.ReactNode;
}) {
  return (
    <section>
      <h4 className={cn(
        'mb-1.5 text-[11px] font-medium uppercase tracking-wide',
        tone === 'error' ? 'text-red-700 dark:text-red-300' : 'text-neutral-500 dark:text-neutral-400',
      )}>
        {title}
      </h4>
      <div>{children}</div>
    </section>
  );
}

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        <span>{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </section>
  );
}

/**
 * Smart value renderer. The whole point of the trace redesign — turn
 * arbitrary JSON values into something that scans for non-developers:
 *   - URLs render as links
 *   - ISO timestamps render as relative + tooltip absolute
 *   - Long strings get a show-more
 *   - Booleans render as pills
 *   - Arrays preview the first few items + total count
 *   - Objects render as a humanized key-value grid
 *   - Numbers / scalars render plain
 */
export function SmartValue({ value }: { value: unknown }): React.ReactElement {
  if (value === null) return <span className="text-neutral-400">null</span>;
  if (value === undefined) return <span className="text-neutral-400">—</span>;
  if (typeof value === 'boolean') {
    return <Badge variant={value ? 'success' : 'secondary'}>{value ? 'true' : 'false'}</Badge>;
  }
  if (typeof value === 'number') {
    return <span className="font-mono text-sm tabular-nums text-neutral-900 dark:text-neutral-100">{value.toLocaleString()}</span>;
  }
  if (typeof value === 'string') {
    return <SmartString value={value} />;
  }
  if (Array.isArray(value)) {
    return <ArrayValue items={value} />;
  }
  if (typeof value === 'object') {
    return <KeyValueGrid value={value as Record<string, unknown>} />;
  }
  return <span className="font-mono text-sm">{String(value)}</span>;
}

function SmartString({ value }: { value: string }) {
  if (value === '') return <span className="text-neutral-400 italic">empty string</span>;
  if (isUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="break-all text-sm text-violet-600 underline hover:text-violet-800 dark:text-violet-400 dark:hover:text-violet-300"
      >
        {value}
      </a>
    );
  }
  if (isIsoDate(value)) {
    return (
      <span title={value} className="text-sm text-neutral-700 dark:text-neutral-300">
        {formatRelativeTime(value)}
      </span>
    );
  }
  if (value.length > 280) return <LongText text={value} />;
  return <span className="break-words text-sm text-neutral-900 dark:text-neutral-100">{value}</span>;
}

function ArrayValue({ items }: { items: unknown[] }) {
  const [showAll, setShowAll] = React.useState(false);
  if (items.length === 0) return <span className="text-neutral-400 italic">empty list</span>;
  // Scalar arrays render as a compact comma-separated row.
  const allScalar = items.every((i) =>
    i === null || i === undefined || typeof i === 'string' || typeof i === 'number' || typeof i === 'boolean'
  );
  if (allScalar) {
    const preview = items.slice(0, 8);
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {preview.map((item, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              {item === null ? 'null' : String(item)}
            </span>
          ))}
        </div>
        {items.length > preview.length && (
          <p className="text-xs text-neutral-500">+ {items.length - preview.length} more</p>
        )}
      </div>
    );
  }
  // Object arrays: show count + N expandable cards.
  const visible = showAll ? items : items.slice(0, 5);
  return (
    <div className="space-y-2">
      <div className="text-xs text-neutral-500">{items.length} item{items.length === 1 ? '' : 's'}</div>
      <div className="space-y-1.5">
        {visible.map((item, i) => (
          <details key={i} className="rounded-md border border-neutral-200 bg-neutral-50/50 dark:border-neutral-800 dark:bg-neutral-900/40">
            <summary className="cursor-pointer px-3 py-1.5 text-xs text-neutral-700 dark:text-neutral-300">
              {arrayItemSummary(item, i)}
            </summary>
            <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <SmartValue value={item} />
            </div>
          </details>
        ))}
      </div>
      {items.length > 5 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          {showAll ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

function arrayItemSummary(item: unknown, index: number): React.ReactNode {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    // Prefer a name-like field if present.
    const candidates = ['name', 'title', 'id', 'status', 'key'];
    for (const k of candidates) {
      const v = obj[k];
      if (typeof v === 'string') return <span><span className="text-neutral-400">{index + 1}. </span>{v}</span>;
    }
    const fieldCount = Object.keys(obj).length;
    return <span>{index + 1}. {fieldCount} field{fieldCount === 1 ? '' : 's'}</span>;
  }
  return <span>{index + 1}. {String(item)}</span>;
}

function KeyValueGrid({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-neutral-400 italic">no fields</span>;
  return (
    <dl className="grid grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {entries.map(([key, val]) => (
        <React.Fragment key={key}>
          <dt
            className="truncate pt-0.5 font-mono text-[12px] text-neutral-500 dark:text-neutral-400"
            title={key}
          >
            {humanizeKey(key)}
          </dt>
          <dd className="min-w-0 pt-0.5">
            <SmartValue value={val} />
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function LongText({ text }: { text: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const isLong = text.length > 280;
  const visible = !isLong || expanded ? text : text.slice(0, 280) + '…';
  return (
    <div className="space-y-1">
      <div className="whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-800 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
        {visible}
      </div>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          {expanded ? 'Show less' : `Show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

/**
 * Renders LLM / agent prose with proper markdown — fenced code blocks
 * stay highlighted, headings and lists structure, links clickable.
 * Defaults to rendered view with a small toggle to the raw text for
 * users who want to see the source markdown. Long text collapses past
 * a threshold to keep cards scannable.
 */
function RichText({ text }: { text: string }) {
  const [mode, setMode] = React.useState<'rendered' | 'plain'>('rendered');
  const [expanded, setExpanded] = React.useState(false);
  const isLong = text.length > 1200;
  const visibleText = !isLong || expanded ? text : text.slice(0, 1200) + '…';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-900">
          {(['rendered', 'plain'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setMode(opt)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] transition',
                mode === opt
                  ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200',
              )}
            >
              {opt === 'rendered' ? 'Rendered' : 'Plain text'}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-neutral-400 dark:text-neutral-500 tabular-nums">
          {text.length.toLocaleString()} chars
        </span>
      </div>
      <div className="overflow-hidden rounded-md border border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-950">
        {mode === 'rendered' ? (
          <MarkdownContent content={visibleText} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-neutral-800 dark:text-neutral-200">
            {visibleText}
          </pre>
        )}
      </div>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function ErrorBlock({ value }: { value: string }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
      {value}
    </pre>
  );
}

function RawJsonFooter({
  output,
  input,
  error,
  reason,
}: {
  output: string | null | undefined;
  input: string | null | undefined;
  error: string | null | undefined;
  reason: string | null | undefined;
}) {
  const [open, setOpen] = React.useState(false);
  const blobs: Array<{ label: string; value: unknown }> = [];
  const tryParse = (v: string | null | undefined) => v ? safeParseJson(v) : null;
  const outputParsed = tryParse(output);
  if (outputParsed !== null) blobs.push({ label: 'Output', value: outputParsed });
  else if (output) blobs.push({ label: 'Output', value: output });
  const inputParsed = tryParse(input);
  if (inputParsed !== null) blobs.push({ label: 'Input', value: inputParsed });
  else if (input) blobs.push({ label: 'Input', value: input });
  if (error) blobs.push({ label: 'Error', value: error });
  if (reason) blobs.push({ label: 'Reason', value: reason });
  if (blobs.length === 0) return null;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-md border border-dashed border-neutral-200 dark:border-neutral-800"
    >
      <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300">
        Raw payload
      </summary>
      <div className="space-y-3 border-t border-dashed border-neutral-200 px-3 py-3 dark:border-neutral-800">
        {blobs.map((b) => (
          <RawJsonBlock key={b.label} label={b.label} value={b.value} />
        ))}
      </div>
    </details>
  );
}

function RawJsonBlock({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(text); } catch { /* noop */ }
  };
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        <span>{label}</span>
        <button type="button" onClick={onCopy} className="normal-case font-normal tracking-normal hover:text-neutral-900 dark:hover:text-neutral-100">copy</button>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">
        {text}
      </pre>
    </div>
  );
}

function StatusPill({ status }: { status: ExecutionNode['status'] }) {
  const variant: 'success' | 'warning' | 'error' | 'secondary' | 'default' =
    status === 'completed' ? 'success'
      : status === 'failed' ? 'error'
        : status === 'waiting_approval' || status === 'waiting_time' || status === 'pending' ? 'warning'
          : status === 'running' ? 'default'
            : 'secondary';
  return <Badge variant={variant} className="shrink-0">{status.replace(/_/g, ' ')}</Badge>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useParsedPayload(raw: string | null | undefined): unknown {
  return React.useMemo(() => {
    if (raw === null || raw === undefined) return null;
    const parsed = safeParseJson(raw);
    if (parsed !== null) {
      // Unwrap once more if the parsed value is itself a JSON-string.
      if (typeof parsed === 'string') {
        const second = safeParseJson(parsed);
        return second !== null ? second : parsed;
      }
      return parsed;
    }
    return raw;
  }, [raw]);
}

function safeParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed[0] !== '{' && trimmed[0] !== '[' && trimmed[0] !== '"') return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(value);
}

function isIsoDate(value: string): boolean {
  // Cheap check first to avoid Date construction for every string.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function humanizeKey(key: string): string {
  // camelCase / snake_case → "camel case" / "snake case"
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bid\b/i, 'ID')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

/**
 * Pull a one-sentence summary out of the trace for the collapsed-card
 * header. Different node types have different "answer" fields.
 */
function describeNodeOutcome(node: ExecutionNode, output: unknown): string | null {
  if (node.error) return node.error.split('\n')[0];
  if (node.reason) return node.reason;
  const o = asObject(output);
  switch (node.nodeType) {
    case 'set': {
      if (!o) return null;
      const keys = Object.keys(o);
      if (keys.length === 0) return 'No values set';
      if (keys.length <= 3) return `Set ${keys.join(', ')}`;
      return `Set ${keys.length} values`;
    }
    case 'if': {
      if (!o) return null;
      const r = o.result === true ? 'true' : 'false';
      return `Branched to ${r}`;
    }
    case 'llm': {
      if (typeof output === 'string') return firstLine(output, 120);
      if (typeof o?.response === 'string') return firstLine(o.response, 120);
      return 'Generated response';
    }
    case 'tool': {
      if (!o) return null;
      // Sheets append/clear: summarize updates.
      const u = asObject(o.updates);
      if (u && typeof u.updatedRange === 'string') {
        const rows = typeof u.updatedRows === 'number' ? `${u.updatedRows} row${u.updatedRows === 1 ? '' : 's'}` : null;
        return [rows, `→ ${u.updatedRange}`].filter(Boolean).join(' ');
      }
      if (typeof o.clearedRange === 'string') return `Cleared ${o.clearedRange}`;
      // Slack send_message: ts + channel.
      if (typeof o.ts === 'string' && typeof o.channel === 'string') return `Posted to ${o.channel}`;
      return null;
    }
    case 'wait': {
      if (!o) return null;
      const resumed = typeof o.resumedAt === 'string' ? o.resumedAt : null;
      return resumed ? `Resumed ${formatRelativeTime(resumed)}` : 'Wait completed';
    }
    case 'approval': {
      if (!o) return null;
      if (o.approved === true) {
        const who = typeof o.approvedBy === 'string' ? o.approvedBy : null;
        return who ? `Approved by ${who}` : 'Approved';
      }
      return 'Denied';
    }
    case 'foreach': {
      if (!o) return null;
      const completed = typeof o.completedCount === 'number' ? o.completedCount : null;
      const total = typeof o.inputCount === 'number' ? o.inputCount : null;
      const failed = typeof o.failedCount === 'number' ? o.failedCount : 0;
      if (completed !== null && total !== null) {
        const base = `${completed} of ${total} iteration${total === 1 ? '' : 's'} completed`;
        return failed > 0 ? `${base} (${failed} failed)` : base;
      }
      return null;
    }
    case 'session':
    case 'orchestrator': {
      if (!o) return null;
      const status = typeof o.finalStatus === 'string' ? o.finalStatus : null;
      const lastMessage = asObject(o.lastMessage);
      const content = typeof lastMessage?.content === 'string' ? firstLine(lastMessage.content, 100) : null;
      if (status === 'completed' && content) return content;
      if (status) return `Session ${status}`;
      return null;
    }
    case 'stop': {
      if (!o) return null;
      const message = typeof o.message === 'string' ? o.message : null;
      if (message) return message;
      const outcome = typeof o.outcome === 'string' ? o.outcome : null;
      return outcome ? `Stopped (${outcome})` : 'Stopped';
    }
    case 'trigger': {
      if (!o) return null;
      const type = typeof o.type === 'string' ? o.type : null;
      return type ? `${type[0].toUpperCase()}${type.slice(1)} trigger` : null;
    }
    default: return null;
  }
}

function firstLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max) + '…' : line;
}
