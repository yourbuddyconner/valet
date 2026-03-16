import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApproveAction, useDenyAction } from '@/api/action-invocations';
import type { InteractivePromptState } from '@/hooks/use-chat';

function useCountdown(expiresAt?: number) {
  const [remaining, setRemaining] = React.useState<string>('');

  React.useEffect(() => {
    if (!expiresAt) return;

    function update() {
      const diff = expiresAt! - Date.now();
      if (diff <= 0) {
        setRemaining('expired');
        return;
      }
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setRemaining(`${mins}:${secs.toString().padStart(2, '0')}`);
    }

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  return remaining;
}

// ─── Param Formatting Utilities ─────────────────────────────────────────────

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function looksLikeId(value: string): boolean {
  return /^[a-f0-9-]{20,}$/i.test(value) || /^[A-Za-z0-9_-]{15,}$/.test(value);
}

function looksLikeMarkdown(value: string): boolean {
  return /[#*_`\[\]|]/.test(value) && value.length > 50;
}

function ParamValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="italic text-neutral-400">null</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="font-mono text-xs">{String(value)}</span>;
  }

  if (typeof value === 'number') {
    return <span className="font-mono text-xs">{value}</span>;
  }

  if (typeof value === 'string') {
    if (looksLikeId(value)) {
      return <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-800">{value}</code>;
    }
    if (value.length > 200 && looksLikeMarkdown(value)) {
      return (
        <div className="mt-1 max-h-48 overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800/50">
          <pre className="whitespace-pre-wrap">{value}</pre>
        </div>
      );
    }
    if (value.length > 200) {
      return <span className="text-xs">{value.slice(0, 200)}&hellip;</span>;
    }
    return <span className="text-xs">{value}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="italic text-neutral-400">[]</span>;
    if (value.every((v) => typeof v === 'string') && value.length <= 5) {
      return <span className="text-xs">{value.join(', ')}</span>;
    }
    return (
      <ul className="ml-4 list-disc text-xs">
        {value.map((item, i) => (
          <li key={i}><ParamValue value={item} /></li>
        ))}
      </ul>
    );
  }

  if (typeof value === 'object') {
    return (
      <div className="ml-2 border-l border-neutral-200 pl-2 dark:border-neutral-700">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="mt-1">
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{humanizeKey(k)}: </span>
            <ParamValue value={v} />
          </div>
        ))}
      </div>
    );
  }

  return <span className="text-xs">{String(value)}</span>;
}

function ExpandableParams({ params }: { params: Record<string, unknown> }) {
  const [expanded, setExpanded] = React.useState(false);
  const entries = Object.entries(params);

  if (entries.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        <span className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>&#9654;</span>
        {expanded ? 'Hide details' : 'Show details'}
      </button>
      {expanded && (
        <div className="mt-2 space-y-1.5 rounded border border-neutral-200 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-800/50">
          {entries.map(([key, value]) => (
            <div key={key}>
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{humanizeKey(key)}: </span>
              <ParamValue value={value} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface InteractivePromptCardProps {
  prompt: InteractivePromptState;
  onAnswer: (promptId: string, answer: string | boolean) => void;
  onApproveWs?: (invocationId: string) => void;
  onDenyWs?: (invocationId: string) => void;
}

export function InteractivePromptCard({ prompt, onAnswer, onApproveWs, onDenyWs }: InteractivePromptCardProps) {
  const approveMutation = useApproveAction();
  const denyMutation = useDenyAction();
  const countdown = useCountdown(prompt.expiresAt);
  const [freeformValue, setFreeformValue] = React.useState('');

  const isResolved = prompt.status !== 'pending';
  const isLoading = approveMutation.isPending || denyMutation.isPending;
  const isApproval = prompt.type === 'approval';

  const invocationId = (prompt.context?.invocationId as string) ?? prompt.id;
  const toolId = prompt.context?.toolId as string | undefined;
  const riskLevel = prompt.context?.riskLevel as string | undefined;
  const params = prompt.context?.params as Record<string, unknown> | undefined;

  function handleActionClick(actionId: string) {
    if (isApproval) {
      if (actionId === 'approve') {
        if (onApproveWs) {
          onApproveWs(invocationId);
        } else {
          approveMutation.mutate(invocationId);
        }
      } else if (actionId === 'deny') {
        if (onDenyWs) {
          onDenyWs(invocationId);
        } else {
          denyMutation.mutate({ invocationId });
        }
      }
    } else {
      const action = prompt.actions.find((a) => a.id === actionId);
      if (action) {
        onAnswer(prompt.id, action.label);
      }
    }
  }

  function handleFreeformSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = freeformValue.trim();
    if (trimmed) {
      onAnswer(prompt.id, trimmed);
    }
  }

  const hasActions = prompt.actions.length > 0;

  return (
    <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/50 dark:bg-amber-900/20">
      {/* Header: action name + risk badge + countdown */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isApproval && toolId ? (
            <code className="truncate text-xs text-neutral-500 dark:text-neutral-400">{toolId}</code>
          ) : (
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {prompt.title}
            </span>
          )}
          {isApproval && riskLevel && (
            <Badge variant={riskBadgeVariant(riskLevel)}>{riskLevel}</Badge>
          )}
        </div>
        {!isResolved && countdown && countdown !== 'expired' && (
          <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
            {countdown}
          </span>
        )}
      </div>

      {/* Summary: model-provided explanation */}
      {prompt.body && (
        <p className="mt-1.5 text-sm text-neutral-800 dark:text-neutral-200">
          {prompt.body}
        </p>
      )}

      {/* Expandable detail: formatted params */}
      {isApproval && params && Object.keys(params).length > 0 && !isResolved && (
        <ExpandableParams params={params} />
      )}

      {/* Action buttons or freeform input */}
      {isResolved ? (
        <div className="mt-2">
          <Badge variant={prompt.status === 'resolved' ? 'success' : 'secondary'}>
            {prompt.status === 'resolved' ? 'Resolved' : 'Expired'}
          </Badge>
        </div>
      ) : hasActions ? (
        <div className="mt-3 flex gap-2">
          {prompt.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.style === 'primary' ? 'primary' : 'outline'}
              onClick={() => handleActionClick(action.id)}
              disabled={isLoading}
              className={
                action.style === 'danger'
                  ? 'border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20'
                  : action.style === 'primary'
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    : ''
              }
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : (
        <form onSubmit={handleFreeformSubmit} className="mt-3 flex gap-2">
          <input
            type="text"
            value={freeformValue}
            onChange={(e) => setFreeformValue(e.target.value)}
            placeholder="Type your answer..."
            className="flex-1 rounded-md border border-neutral-300 bg-surface-0 px-2.5 py-1.5 text-[13px] text-neutral-900 focus:outline-none focus:ring-2 focus:ring-amber-400/40 dark:border-neutral-600 dark:bg-surface-1 dark:text-neutral-100"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!freeformValue.trim()}>
            Answer
          </Button>
        </form>
      )}
    </div>
  );
}

function riskBadgeVariant(level: string): 'success' | 'warning' | 'error' | 'default' {
  switch (level) {
    case 'low': return 'success';
    case 'medium': return 'warning';
    case 'high': return 'error';
    case 'critical': return 'error';
    default: return 'default';
  }
}
