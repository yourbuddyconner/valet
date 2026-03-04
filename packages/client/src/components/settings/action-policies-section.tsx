import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useActionPolicies, useUpsertActionPolicy, useDeleteActionPolicy } from '@/api/action-policies';
import { useActionCatalog } from '@/api/action-catalog';
import type { ActionCatalogEntry } from '@/api/action-catalog';
import { ActionPolicyDialog } from './action-policy-dialog';
import type { ActionPolicy } from '@valet/shared';

function modeBadgeVariant(mode: string): 'success' | 'warning' | 'error' {
  switch (mode) {
    case 'allow': return 'success';
    case 'require_approval': return 'warning';
    case 'deny': return 'error';
    default: return 'warning';
  }
}

function modeLabel(mode: string): string {
  switch (mode) {
    case 'allow': return 'Allow';
    case 'require_approval': return 'Require Approval';
    case 'deny': return 'Deny';
    default: return mode;
  }
}

function scopeLabel(
  policy: ActionPolicy,
  catalog: ActionCatalogEntry[] | undefined,
): { badge: string; target: React.ReactNode } {
  if (policy.actionId) {
    const entry = catalog?.find((e) => e.actionId === policy.actionId);
    return {
      badge: 'Action',
      target: (
        <span className="flex items-baseline gap-1.5">
          {entry ? (
            <>
              <span className="text-neutral-900 dark:text-neutral-100">{entry.serviceDisplayName} &rsaquo; {entry.name}</span>
              <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">{policy.actionId}</span>
            </>
          ) : (
            <span className="font-mono">{policy.service}:{policy.actionId}</span>
          )}
        </span>
      ),
    };
  }
  if (policy.service) {
    const entry = catalog?.find((e) => e.service === policy.service);
    const displayName = entry?.serviceDisplayName ?? policy.service;
    return {
      badge: 'Service',
      target: (
        <span className="flex items-baseline gap-1.5">
          <span className="text-neutral-900 dark:text-neutral-100">{displayName}</span>
          {displayName !== policy.service && (
            <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">{policy.service}</span>
          )}
        </span>
      ),
    };
  }
  if (policy.riskLevel) {
    return { badge: 'Risk Level', target: policy.riskLevel };
  }
  return { badge: 'Unknown', target: '-' };
}

export function ActionPoliciesSection() {
  const { data: policies, isLoading } = useActionPolicies();
  const { data: catalog } = useActionCatalog();
  const upsertMutation = useUpsertActionPolicy();
  const deleteMutation = useDeleteActionPolicy();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingPolicy, setEditingPolicy] = React.useState<ActionPolicy | null>(null);

  function handleAdd() {
    setEditingPolicy(null);
    setDialogOpen(true);
  }

  function handleEdit(policy: ActionPolicy) {
    setEditingPolicy(policy);
    setDialogOpen(true);
  }

  function handleSave(data: {
    id: string;
    service?: string | null;
    actionId?: string | null;
    riskLevel?: string | null;
    mode: string;
  }) {
    upsertMutation.mutate(data, {
      onSuccess: () => setDialogOpen(false),
    });
  }

  function handleDelete(id: string) {
    if (confirm('Delete this policy?')) {
      deleteMutation.mutate(id);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">Action Policies</h2>
        <Button size="sm" onClick={handleAdd}>Add Policy</Button>
      </div>

      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Control how integration actions are gated. When no policy matches, system defaults apply: low = allow, medium/high = require approval, critical = deny.
      </p>

      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : !policies || policies.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No custom policies configured. System defaults are in effect.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-700">
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Scope</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Target</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Mode</th>
                <th className="pb-2 text-right font-medium text-neutral-500 dark:text-neutral-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => {
                const { badge, target } = scopeLabel(policy, catalog);
                return (
                  <tr key={policy.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-700/50">
                    <td className="py-2">
                      <Badge variant="secondary">{badge}</Badge>
                    </td>
                    <td className="py-2 text-xs">{target}</td>
                    <td className="py-2">
                      <Badge variant={modeBadgeVariant(policy.mode)}>{modeLabel(policy.mode)}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(policy)}
                        className="mr-1"
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(policy.id)}
                        className="text-red-600 hover:text-red-700 dark:text-red-400"
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ActionPolicyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        policy={editingPolicy}
        onSave={handleSave}
        isPending={upsertMutation.isPending}
      />
    </div>
  );
}
