import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import type { ActionPolicy, ActionMode } from '@agent-ops/shared';

interface ActionPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy?: ActionPolicy | null;
  onSave: (data: {
    id: string;
    service?: string | null;
    actionId?: string | null;
    riskLevel?: string | null;
    mode: string;
  }) => void;
  isPending?: boolean;
}

type PolicyScope = 'action' | 'service' | 'risk_level';

const selectClass =
  'mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400';

function inferScope(policy: ActionPolicy): PolicyScope {
  if (policy.actionId) return 'action';
  if (policy.service) return 'service';
  return 'risk_level';
}

export function ActionPolicyDialog({ open, onOpenChange, policy, onSave, isPending }: ActionPolicyDialogProps) {
  const [scope, setScope] = React.useState<PolicyScope>('action');
  const [service, setService] = React.useState('');
  const [actionId, setActionId] = React.useState('');
  const [riskLevel, setRiskLevel] = React.useState('medium');
  const [mode, setMode] = React.useState<ActionMode>('require_approval');

  React.useEffect(() => {
    if (policy) {
      setScope(inferScope(policy));
      setService(policy.service || '');
      setActionId(policy.actionId || '');
      setRiskLevel(policy.riskLevel || 'medium');
      setMode(policy.mode);
    } else {
      setScope('action');
      setService('');
      setActionId('');
      setRiskLevel('medium');
      setMode('require_approval');
    }
  }, [policy, open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const id = policy?.id || crypto.randomUUID();
    const data: {
      id: string;
      service?: string | null;
      actionId?: string | null;
      riskLevel?: string | null;
      mode: string;
    } = { id, mode };

    switch (scope) {
      case 'action':
        data.service = service || null;
        data.actionId = actionId || null;
        break;
      case 'service':
        data.service = service || null;
        data.actionId = null;
        data.riskLevel = null;
        break;
      case 'risk_level':
        data.service = null;
        data.actionId = null;
        data.riskLevel = riskLevel;
        break;
    }

    onSave(data);
  }

  const isValid = (() => {
    switch (scope) {
      case 'action': return !!service && !!actionId;
      case 'service': return !!service;
      case 'risk_level': return !!riskLevel;
    }
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{policy ? 'Edit Policy' : 'Add Policy'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Scope
            </label>
            <select
              className={selectClass}
              value={scope}
              onChange={(e) => setScope(e.target.value as PolicyScope)}
            >
              <option value="action">Specific Action</option>
              <option value="service">Entire Service</option>
              <option value="risk_level">Risk Level</option>
            </select>
          </div>

          {(scope === 'action' || scope === 'service') && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Service
              </label>
              <Input
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="e.g. gmail, github, slack"
              />
            </div>
          )}

          {scope === 'action' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Action ID
              </label>
              <Input
                value={actionId}
                onChange={(e) => setActionId(e.target.value)}
                placeholder="e.g. gmail.send_email"
              />
            </div>
          )}

          {scope === 'risk_level' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Risk Level
              </label>
              <select
                className={selectClass}
                value={riskLevel}
                onChange={(e) => setRiskLevel(e.target.value)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Mode
            </label>
            <select
              className={selectClass}
              value={mode}
              onChange={(e) => setMode(e.target.value as ActionMode)}
            >
              <option value="allow">Allow</option>
              <option value="require_approval">Require Approval</option>
              <option value="deny">Deny</option>
            </select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || isPending}>
              {isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
