import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApproveAction, useDenyAction } from '@/api/action-invocations';
import { ApiError } from '@/api/client';
import type { InteractivePromptState } from '@/hooks/use-chat';
import {
  buildApprovalResolutionSocketMessage,
  getApprovalActionDescription,
  getDefaultApprovalActionId,
  getNextApprovalActionId,
  isApprovalCancelAction,
  isApprovalPromptExpired,
} from '@/lib/approval-prompts';

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
      return <code className="break-all rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-800">{value}</code>;
    }
    if (value.length > 200 && looksLikeMarkdown(value)) {
      return (
        <div className="mt-1 max-h-48 overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800/50">
          <pre className="whitespace-pre-wrap">{value}</pre>
        </div>
      );
    }
    if (value.length > 200) {
      return <span className="break-words text-xs">{value.slice(0, 200)}&hellip;</span>;
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
  onDismiss: (promptId: string) => void;
  onResolveApprovalWs?: (invocationId: string, actionId: string) => boolean;
  onApproveWs?: (invocationId: string, actionId?: string) => boolean;
  onDenyWs?: (invocationId: string, actionId?: string) => boolean;
  onResolveLocal?: (promptId: string) => void;
  onExpireLocal?: (promptId: string) => void;
}

export function InteractivePromptCard({
  prompt,
  onAnswer,
  onDismiss,
  onResolveApprovalWs,
  onApproveWs,
  onDenyWs,
  onResolveLocal,
  onExpireLocal,
}: InteractivePromptCardProps) {
  const approveMutation = useApproveAction();
  const denyMutation = useDenyAction();
  const countdown = useCountdown(prompt.expiresAt);
  const [freeformValue, setFreeformValue] = React.useState('');
  const [isSubmitted, setIsSubmitted] = React.useState(false);
  const [submissionError, setSubmissionError] = React.useState<string | null>(null);
  const [selectedApprovalActionId, setSelectedApprovalActionId] = React.useState(() => getDefaultApprovalActionId(prompt.actions));

  const isResolved = prompt.status !== 'pending';
  const isApproval = prompt.type === 'approval';
  const isLoading = isApproval && (approveMutation.isPending || denyMutation.isPending);
  const isExpired = isApproval && isApprovalPromptExpired(prompt.expiresAt);
  const isDisabled = isLoading || isSubmitted || isExpired;

  const invocationId = (prompt.context?.invocationId as string) ?? prompt.id;
  const toolId = prompt.context?.toolId as string | undefined;
  const riskLevel = prompt.context?.riskLevel as string | undefined;
  const params = prompt.context?.params as Record<string, unknown> | undefined;

  React.useEffect(() => {
    if (!isApproval || prompt.actions.length === 0) return;
    setSelectedApprovalActionId((current) => (
      prompt.actions.some((action) => action.id === current)
        ? current
        : getDefaultApprovalActionId(prompt.actions)
    ));
  }, [isApproval, prompt.actions]);

  React.useEffect(() => {
    if (isApproval && prompt.status === 'pending' && isExpired) {
      onExpireLocal?.(prompt.id);
    }
  }, [isApproval, isExpired, onExpireLocal, prompt.id, prompt.status]);

  React.useEffect(() => {
    if (prompt.status === 'pending' && prompt.error) {
      setIsSubmitted(false);
      setSubmissionError(prompt.error);
    }
  }, [prompt.error, prompt.status]);

  function handleApprovalMutationError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setSubmissionError(message);
    if (error instanceof ApiError && [404, 409, 410].includes(error.status)) {
      onExpireLocal?.(prompt.id);
      return;
    }
    setIsSubmitted(false);
  }

  function submitApprovalAction(actionId: string) {
    if (isDisabled) return;
    setSubmissionError(null);

    const message = buildApprovalResolutionSocketMessage(invocationId, actionId);
    const sentViaUnifiedWs = onResolveApprovalWs?.(invocationId, actionId) ?? false;
    if (sentViaUnifiedWs) {
      setIsSubmitted(true);
      return;
    }

    if (message.type === 'approve-action') {
      const sentViaApproveWs = onApproveWs?.(invocationId, actionId) ?? false;
      if (sentViaApproveWs) {
        setIsSubmitted(true);
        return;
      }
      setIsSubmitted(true);
      approveMutation.mutate(
        { invocationId, actionId },
        {
          onSuccess: () => onResolveLocal?.(prompt.id),
          onError: handleApprovalMutationError,
        },
      );
      return;
    }

    const sentViaDenyWs = onDenyWs?.(invocationId, actionId) ?? false;
    if (sentViaDenyWs) {
      setIsSubmitted(true);
      return;
    }
    setIsSubmitted(true);
    denyMutation.mutate(
      { invocationId, actionId },
      {
        onSuccess: () => onResolveLocal?.(prompt.id),
        onError: handleApprovalMutationError,
      },
    );
  }

  function handleActionClick(actionId: string) {
    if (isDisabled) return;
    if (isApproval) {
      submitApprovalAction(actionId);
    } else {
      setIsSubmitted(true);
      const action = prompt.actions.find((a) => a.id === actionId);
      if (action) {
        onAnswer(prompt.id, action.label);
      }
    }
  }

  function handleDismiss() {
    if (isDisabled) return;
    setIsSubmitted(true);
    onDismiss(prompt.id);
  }

  function handleFreeformSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = freeformValue.trim();
    if (!trimmed || isSubmitted) return;
    setIsSubmitted(true);
    setFreeformValue('');
    onAnswer(prompt.id, trimmed);
  }

  function handleApprovalKeyDown(e: React.KeyboardEvent) {
    if (!isApproval || isResolved || isDisabled || prompt.actions.length === 0) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSelectedApprovalActionId((current) => getNextApprovalActionId(prompt.actions, current, 1));
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setSelectedApprovalActionId((current) => getNextApprovalActionId(prompt.actions, current, -1));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      submitApprovalAction(selectedApprovalActionId || getDefaultApprovalActionId(prompt.actions));
      return;
    }

    if (e.key === 'Escape') {
      const cancelActionId = prompt.actions.find((action) => isApprovalCancelAction(action.id))?.id;
      if (cancelActionId) {
        e.preventDefault();
        submitApprovalAction(cancelActionId);
      }
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
        <div className="flex shrink-0 items-center gap-2">
          {!isResolved && !isApproval && (
            <button
              type="button"
              onClick={handleDismiss}
              disabled={isDisabled}
              className="text-xs text-neutral-400 hover:text-neutral-600 disabled:opacity-50 dark:text-neutral-500 dark:hover:text-neutral-300"
            >
              Skip
            </button>
          )}
          {!isResolved && countdown && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {countdown}
            </span>
          )}
        </div>
      </div>

      {/* Summary: model-provided explanation */}
      {prompt.body && (
        <p className="mt-1.5 text-sm text-neutral-800 dark:text-neutral-200">
          {prompt.body}
        </p>
      )}

      {(submissionError || prompt.error) && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {submissionError || prompt.error}
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
      ) : isApproval && hasActions ? (
        <div
          className="mt-3 flex flex-wrap gap-2"
          role="listbox"
          aria-label={prompt.title}
          tabIndex={0}
          onKeyDown={handleApprovalKeyDown}
        >
          {prompt.actions.map((action) => {
            const selected = action.id === selectedApprovalActionId;
            const description = getApprovalActionDescription(action);
            const isCancel = isApprovalCancelAction(action.id);
            return (
              <button
                key={action.id}
                type="button"
                role="option"
                aria-selected={selected}
                title={description || undefined}
                onFocus={() => setSelectedApprovalActionId(action.id)}
                onMouseEnter={() => setSelectedApprovalActionId(action.id)}
                onClick={() => handleActionClick(action.id)}
                disabled={isDisabled}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                  isCancel
                    ? selected
                      ? 'border-red-300 bg-red-50 text-red-600 ring-2 ring-red-400/40 dark:border-red-700 dark:bg-red-900/30 dark:text-red-400'
                      : 'border-neutral-200 text-red-600 hover:border-red-300 hover:bg-red-50 dark:border-neutral-700 dark:text-red-400 dark:hover:border-red-700 dark:hover:bg-red-900/30'
                    : selected
                      ? 'border-amber-300 bg-amber-100 text-neutral-900 ring-2 ring-amber-400/40 dark:border-amber-700 dark:bg-amber-900/30 dark:text-neutral-100'
                      : 'border-neutral-200 text-neutral-700 hover:border-amber-300 hover:bg-amber-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-amber-700 dark:hover:bg-amber-900/20'
                }`}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      ) : hasActions ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            {prompt.actions.map((action) => (
              <Button
                key={action.id}
                size="sm"
                variant={action.style === 'primary' ? 'primary' : 'outline'}
                onClick={() => handleActionClick(action.id)}
                disabled={isDisabled}
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
          {!isApproval && (
            <form onSubmit={handleFreeformSubmit} className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={freeformValue}
                onChange={(e) => setFreeformValue(e.target.value)}
                disabled={isSubmitted}
                placeholder="Or type your own answer..."
                className="flex-1 rounded-md border border-neutral-300 bg-surface-0 px-2.5 py-1.5 text-[13px] text-neutral-900 focus:outline-none focus:ring-2 focus:ring-amber-400/40 dark:border-neutral-600 dark:bg-surface-1 dark:text-neutral-100"
              />
              <Button type="submit" size="sm" variant="outline" className="w-full sm:w-auto" disabled={isSubmitted || !freeformValue.trim()}>
                Answer
              </Button>
            </form>
          )}
        </div>
      ) : (
        <form onSubmit={handleFreeformSubmit} className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={freeformValue}
            onChange={(e) => setFreeformValue(e.target.value)}
            placeholder="Type your answer..."
            className="flex-1 rounded-md border border-neutral-300 bg-surface-0 px-2.5 py-1.5 text-[13px] text-neutral-900 focus:outline-none focus:ring-2 focus:ring-amber-400/40 dark:border-neutral-600 dark:bg-surface-1 dark:text-neutral-100"
            autoFocus
          />
          <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={!freeformValue.trim()}>
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
