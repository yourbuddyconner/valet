import { useState, type ReactNode } from 'react';
import type { Message, MessagePart } from '@valet/shared';
import type { ExecutionStepTrace } from '@/api/executions';
import { StepIcon } from '@/components/workflows/step-cards/icons';

interface AgentPromptOutput {
  response?: unknown;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

interface Props {
  step: ExecutionStepTrace | null;
  messages: Message[];
  /** Renders a run of messages via the chat's turn grouping (user + assistant). */
  renderMessages: (msgs: Message[]) => ReactNode;
}

/**
 * Wraps the prompt + streamed assistant turn(s) of a workflow `agent_prompt`
 * step in a per-step container, with a header carrying step metadata. The
 * execution detail page shows the step-card summary; this is the live forensic
 * view in the session chat.
 *
 * - Structured-output steps render the parsed result as a card; the raw
 *   streamed JSON turn is tucked into a collapsible panel.
 * - Superseded attempts (model failover / structured-output fixup) — assistant
 *   turns the runner finalized 'canceled' — collapse behind a "previous
 *   attempts" affordance so the latest attempt reads cleanly.
 */
export function WorkflowStepContainer({ step, messages, renderMessages }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const [showAttempts, setShowAttempts] = useState(false);

  const input = (step?.input ?? null) as Record<string, unknown> | null;
  const output = (step?.output ?? null) as AgentPromptOutput | null;
  const name = pickString(input, ['name']) ?? step?.stepId ?? 'agent_prompt';
  const persona = pickString(input, ['persona']);
  const iter = step ? parseIterFromPath(step.iterationPath) : null;
  const status = mapStatus(step?.status);
  const meta = formatMeta(output);

  const userMsgs = messages.filter((m) => m.role === 'user' || m.role === 'system');
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  const canceledTurns = assistantMsgs.filter(isCanceledTurn);
  const keptTurns = assistantMsgs.filter((m) => !isCanceledTurn(m));

  const structured =
    output?.response != null &&
    typeof output.response === 'object' &&
    !Array.isArray(output.response);

  return (
    <div
      className={`my-2 overflow-hidden rounded-lg border ${STATUS_BORDER[status]} bg-surface-0 dark:bg-surface-0`}
      data-component="workflow-step-container"
    >
      <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1.5 dark:border-neutral-800">
        <span className={`h-3.5 w-3.5 shrink-0 ${STATUS_TEXT[status]}`}>
          <StepIcon kind="agent_prompt" />
        </span>
        <span className="font-mono text-[11px] font-semibold text-neutral-700 dark:text-neutral-300">
          {name}
        </span>
        {persona && (
          <span className="rounded border border-indigo-400/40 bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[9px] text-indigo-600 dark:text-indigo-300">
            {persona}
          </span>
        )}
        {iter && (
          <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">{iter}</span>
        )}
        {meta && (
          <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">{meta}</span>
        )}
        <span className={`ml-auto font-mono text-[10px] ${STATUS_TEXT[status]}`}>
          {status === 'running' ? 'streaming…' : status}
        </span>
      </div>

      <div className="px-3 py-2">
        {/* The prompt. */}
        {userMsgs.length > 0 && renderMessages(userMsgs)}

        {structured ? (
          <>
            {/* Parsed structured result as the primary view. */}
            <StructuredResultTable data={output!.response as Record<string, unknown>} />
            {/* Raw streamed JSON tucked away. */}
            {keptTurns.length > 0 && (
              <CollapsibleSection
                label={showRaw ? 'Hide raw output' : 'Show raw output'}
                open={showRaw}
                onToggle={() => setShowRaw((v) => !v)}
              >
                {renderMessages(keptTurns)}
              </CollapsibleSection>
            )}
          </>
        ) : (
          // Plain (non-structured) — render the kept assistant turn(s) directly.
          keptTurns.length > 0 && renderMessages(keptTurns)
        )}

        {/* Superseded attempts (failover / fixup), collapsed. */}
        {canceledTurns.length > 0 && (
          <CollapsibleSection
            label={
              showAttempts
                ? 'Hide previous attempts'
                : `${canceledTurns.length} previous attempt${canceledTurns.length === 1 ? '' : 's'}`
            }
            open={showAttempts}
            onToggle={() => setShowAttempts((v) => !v)}
          >
            {renderMessages(canceledTurns)}
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}

function CollapsibleSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onToggle}
        className="font-mono text-[10px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
      >
        {open ? '▾ ' : '▸ '}
        {label}
      </button>
      {open && (
        <div className="mt-1 border-l border-neutral-200 pl-3 opacity-90 dark:border-neutral-800">
          {children}
        </div>
      )}
    </div>
  );
}

function StructuredResultTable({ data }: { data: Record<string, unknown> }) {
  return (
    <dl className="my-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-neutral-500 dark:text-neutral-400">{k}</dt>
          <dd className="whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-300">
            {typeof v === 'string' ? v : JSON.stringify(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function isCanceledTurn(m: Message): boolean {
  const parts = Array.isArray(m.parts) ? (m.parts as MessagePart[]) : [];
  return parts.some((p) => p.type === 'finish' && (p as { reason?: string }).reason === 'canceled');
}

const STATUS_BORDER: Record<string, string> = {
  pending: 'border-neutral-200 dark:border-neutral-700/80',
  running: 'border-accent/30 dark:border-accent/20',
  completed: 'border-neutral-200 dark:border-neutral-700/80',
  error: 'border-red-200 dark:border-red-900/40',
};

const STATUS_TEXT: Record<string, string> = {
  pending: 'text-neutral-400 dark:text-neutral-500',
  running: 'text-accent',
  completed: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-red-500 dark:text-red-400',
};

function formatMeta(output: AgentPromptOutput | null): string {
  if (!output) return '';
  const parts: string[] = [];
  if (output.model) parts.push(output.model);
  if (output.inputTokens != null && output.outputTokens != null) {
    parts.push(`${output.inputTokens}↓ ${output.outputTokens}↑`);
  }
  return parts.join(' · ');
}

function parseIterFromPath(path: string): string | null {
  if (!path) return null;
  const last = path.split('/').pop()!;
  const idx = last.indexOf(':');
  if (idx < 0) return null;
  const disc = last.slice(idx + 1);
  if (disc.startsWith('i')) return `iter ${Number(disc.slice(1)) + 1}`;
  if (disc.startsWith('b')) return `branch ${Number(disc.slice(1)) + 1}`;
  if (disc === 'then' || disc === 'else') return disc;
  return null;
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (typeof obj[k] === 'string') return obj[k] as string;
  }
  return undefined;
}

function mapStatus(status: string | undefined): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running' || status === 'waiting_approval') return 'running';
  return 'pending';
}
