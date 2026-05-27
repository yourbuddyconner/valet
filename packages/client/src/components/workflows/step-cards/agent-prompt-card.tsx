import { useEffect, useState } from 'react';
import { ToolCardShell, ToolCardSection } from '@/components/chat/tool-cards/tool-card-shell';
import { DeferredMarkdownContent } from '@/components/chat/markdown/deferred-markdown-content';
import { StepIcon } from './icons';
import { bump, WORKFLOW_TELEMETRY } from '@/lib/workflow-telemetry';
import type { WorkflowStepCardProps } from './index';

interface AgentPromptOutput {
  response: unknown;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

export function AgentPromptCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const input = step.input as Record<string, unknown> | null;
  const output = step.output as AgentPromptOutput | null;
  const persona = typeof input?.persona === 'string' ? input.persona : undefined;
  const promptText = pickString(input, ['prompt', 'content', 'message', 'goal']) ?? '';

  const status = mapStatus(step.status);
  const isRunning = status === 'running' || status === 'pending';
  const elapsed = useElapsed(step.startedAt, !isRunning);
  const meta = formatMeta(step, output, elapsed);

  // A completed agent_prompt with no response is a broken pipeline (the
  // runner should always emit output for completed steps post-Phase B).
  useEffect(() => {
    if (status === 'completed' && !output) {
      bump(WORKFLOW_TELEMETRY.AGENT_PROMPT_RESPONSE_MISSING, {
        stepId: step.stepId,
        iterationPath: step.iterationPath,
      });
    }
  }, [status, output, step.stepId, step.iterationPath]);

  return (
    <ToolCardShell
      icon={<StepIcon kind="agent_prompt" />}
      label="agent_prompt"
      status={status}
      summary={summaryLine(step, persona, output)}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      <ToolCardSection label={`prompt${persona ? ` · ${persona}` : ''}`}>
        <p className="font-mono text-[11px] italic text-neutral-500 dark:text-neutral-400 whitespace-pre-wrap">
          {promptText || <em>(no prompt)</em>}
        </p>
      </ToolCardSection>

      <ToolCardSection label={`response · ${meta}`}>
        {renderResponse(output, status, step.error)}
      </ToolCardSection>
    </ToolCardShell>
  );
}

function renderResponse(
  output: AgentPromptOutput | null,
  status: 'pending' | 'running' | 'completed' | 'error',
  error: string | null,
) {
  if (status === 'pending' || status === 'running') {
    return <p className="font-mono text-[11px] text-neutral-500">…</p>;
  }
  if (status === 'error') {
    return (
      <p className="font-mono text-[11px] text-red-600 dark:text-red-400 whitespace-pre-wrap">
        {error || 'Step failed without an error message.'}
      </p>
    );
  }
  if (!output) return <p className="font-mono text-[11px] text-neutral-500">(no response)</p>;

  const r = output.response;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    return (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
        {Object.entries(r as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-500 dark:text-neutral-400">{k}</dt>
            <dd className="text-neutral-700 dark:text-neutral-300 break-words whitespace-pre-wrap">
              {typeof v === 'string' ? v : JSON.stringify(v)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (typeof r === 'string') {
    return <DeferredMarkdownContent content={r} />;
  }
  return <p className="font-mono text-[11px]">{JSON.stringify(r)}</p>;
}

function summaryLine(
  step: { iterationPath: string },
  persona: string | undefined,
  output: AgentPromptOutput | null,
): string {
  const parts: string[] = [];
  if (persona) parts.push(persona);
  const iter = parseIterFromPath(step.iterationPath);
  if (iter) parts.push(iter);
  const r = output?.response;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const k = Object.keys(r as object);
    if (k.length) parts.push(`{${k.slice(0, 3).join(', ')}${k.length > 3 ? ', …' : ''}}`);
  } else if (typeof r === 'string') {
    const preview = r.slice(0, 60).replace(/\s+/g, ' ');
    parts.push(`"${preview}${r.length > 60 ? '…' : ''}"`);
  }
  return parts.join(' · ');
}

function formatMeta(
  step: { startedAt: string | null; completedAt: string | null },
  output: AgentPromptOutput | null,
  elapsedMs: number,
): string {
  const dur = step.completedAt && step.startedAt
    ? new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
    : elapsedMs;
  const tokenStr = output?.inputTokens != null && output?.outputTokens != null
    ? ` · ${output.inputTokens}↓ ${output.outputTokens}↑`
    : '';
  const modelStr = output?.model ? ` · ${output.model}` : '';
  return `${dur}ms${modelStr}${tokenStr}`;
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

function useElapsed(startedAt: string | null, paused: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (paused || !startedAt) return;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [paused, startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, now - new Date(startedAt).getTime());
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (typeof obj[k] === 'string') return obj[k] as string;
  }
  return undefined;
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running' || status === 'waiting_approval') return 'running';
  return 'pending';
}
