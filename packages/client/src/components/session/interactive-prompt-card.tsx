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

  // For approval prompts, extract invocationId from context
  const invocationId = (prompt.context?.invocationId as string) ?? prompt.id;

  function handleActionClick(actionId: string) {
    if (isApproval) {
      // Route through HTTP approve/deny endpoints
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
      // Question-type: send the action label as the answer
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
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {prompt.title}
            </span>
            {isApproval && typeof prompt.context?.riskLevel === 'string' && (
              <Badge variant={riskBadgeVariant(prompt.context.riskLevel)}>
                {prompt.context.riskLevel}
              </Badge>
            )}
          </div>
          {prompt.body && (
            <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
              {prompt.body}
            </p>
          )}
        </div>

        {!isResolved && countdown && countdown !== 'expired' && (
          <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
            {countdown}
          </span>
        )}
      </div>

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
