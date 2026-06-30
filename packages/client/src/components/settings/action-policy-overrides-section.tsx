import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  useActionPolicyOverrides,
  useDeleteActionPolicyOverride,
  useUpsertActionPolicyOverride,
} from '@/api/action-policy-overrides';
import { useActionCatalog } from '@/api/action-catalog';
import type { ActionCatalogEntry } from '@/api/action-catalog';
import { ActionPolicyDialog, type EditableActionPolicy } from './action-policy-dialog';
import {
  canEditActionPolicyOverride,
  getActionPolicyOverrideLifetimeLabel,
  splitActionPolicyOverrides,
} from './action-policy-overrides-utils';
import type { ActionPolicyOverride } from '@valet/shared';

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

function lifetimeBadgeVariant(override: ActionPolicyOverride): 'success' | 'warning' | 'secondary' {
  if (override.lifetime === 'persistent') return 'success';
  if (override.lifetime === 'session') return 'warning';
  return 'secondary';
}

function scopeLabel(
  override: ActionPolicyOverride,
  catalog: ActionCatalogEntry[] | undefined,
): { badge: string; target: React.ReactNode } {
  if (override.actionId) {
    const entry = catalog?.find((e) => e.service === override.service && e.actionId === override.actionId);
    return {
      badge: 'Action',
      target: (
        <span className="flex items-baseline gap-1.5">
          {entry ? (
            <>
              <span className="text-neutral-900 dark:text-neutral-100">{entry.serviceDisplayName} &rsaquo; {entry.name}</span>
              <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">{override.actionId}</span>
            </>
          ) : (
            <span className="font-mono">{override.service}:{override.actionId}</span>
          )}
        </span>
      ),
    };
  }
  if (override.service) {
    const entry = catalog?.find((e) => e.service === override.service);
    const displayName = entry?.serviceDisplayName ?? override.service;
    return {
      badge: 'Service',
      target: (
        <span className="flex items-baseline gap-1.5">
          <span className="text-neutral-900 dark:text-neutral-100">{displayName}</span>
          {displayName !== override.service && (
            <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">{override.service}</span>
          )}
        </span>
      ),
    };
  }
  if (override.riskLevel) {
    return { badge: 'Risk Level', target: override.riskLevel };
  }
  return { badge: 'Unknown', target: '-' };
}

function toEditablePolicy(override: ActionPolicyOverride): EditableActionPolicy {
  return {
    id: override.id,
    service: override.service,
    actionId: override.actionId,
    riskLevel: override.riskLevel,
    mode: override.mode,
    appliesIn: override.appliesIn,
    paramMatchers: override.paramMatchers,
  };
}

function OverridesTable({
  overrides,
  catalog,
  onEdit,
  onDelete,
  deletePending,
}: {
  overrides: ActionPolicyOverride[];
  catalog: ActionCatalogEntry[] | undefined;
  onEdit: (override: ActionPolicyOverride) => void;
  onDelete: (id: string) => void;
  deletePending: boolean;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-neutral-200 dark:border-neutral-700">
          <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Scope</th>
          <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Target</th>
          <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Effect</th>
          <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Lifetime</th>
          <th className="pb-2 text-right font-medium text-neutral-500 dark:text-neutral-400">Actions</th>
        </tr>
      </thead>
      <tbody>
        {overrides.map((override) => {
          const { badge, target } = scopeLabel(override, catalog);
          const editable = canEditActionPolicyOverride(override);
          return (
            <tr key={override.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-700/50">
              <td className="py-2">
                <Badge variant="secondary">{badge}</Badge>
              </td>
              <td className="py-2 text-xs">{target}</td>
              <td className="py-2">
                <Badge variant={modeBadgeVariant(override.mode)}>{modeLabel(override.mode)}</Badge>
              </td>
              <td className="py-2">
                <Badge variant={lifetimeBadgeVariant(override)}>{getActionPolicyOverrideLifetimeLabel(override)}</Badge>
              </td>
              <td className="py-2 text-right">
                {editable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(override)}
                    className="mr-1"
                  >
                    Edit
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(override.id)}
                  disabled={deletePending}
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
  );
}

export function ActionPolicyOverridesSection() {
  const { data: overrides, isLoading } = useActionPolicyOverrides();
  const { data: catalog } = useActionCatalog();
  const upsertMutation = useUpsertActionPolicyOverride();
  const deleteMutation = useDeleteActionPolicyOverride();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingOverride, setEditingOverride] = React.useState<ActionPolicyOverride | null>(null);

  const split = React.useMemo(
    () => splitActionPolicyOverrides(overrides ?? []),
    [overrides],
  );

  function handleAdd() {
    setEditingOverride(null);
    setDialogOpen(true);
  }

  function handleEdit(override: ActionPolicyOverride) {
    setEditingOverride(override);
    setDialogOpen(true);
  }

  function handleSave(data: {
    id: string;
    service?: string | null;
    actionId?: string | null;
    riskLevel?: string | null;
    mode: string;
    appliesIn?: 'any' | 'workflow' | 'session';
    paramMatchers?: import('@valet/shared').ParamMatcher[];
  }) {
    upsertMutation.mutate(data, {
      onSuccess: () => setDialogOpen(false),
    });
  }

  function handleDelete(id: string) {
    if (confirm('Delete this rule?')) {
      deleteMutation.mutate(id);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">Auto-approval rules</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Durable allow rules that skip the approval prompt for matching tool calls. Pick an action, an entire service, or a risk level. Organization deny / require-approval policies still take precedence — these only loosen the default, they can't override admin restrictions.
          </p>
        </div>
        <Button size="sm" onClick={handleAdd}>Add rule</Button>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : split.persistent.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No rules yet. Tools will keep asking for approval until you add one — or until you click <em>Always Allow</em> from an approval card.
          </p>
        ) : (
          <OverridesTable
            overrides={split.persistent}
            catalog={catalog}
            onEdit={handleEdit}
            onDelete={handleDelete}
            deletePending={deleteMutation.isPending}
          />
        )}
      </div>

      {split.temporary.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Temporary Overrides</h3>
          <div className="mt-2">
            <OverridesTable
              overrides={split.temporary}
              catalog={catalog}
              onEdit={handleEdit}
              onDelete={handleDelete}
              deletePending={deleteMutation.isPending}
            />
          </div>
        </div>
      )}

      {upsertMutation.error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">
          {upsertMutation.error instanceof Error ? upsertMutation.error.message : 'Failed to save override'}
        </p>
      )}

      <ActionPolicyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        policy={editingOverride ? toEditablePolicy(editingOverride) : null}
        noun="rule"
        allowOnly
        onSave={handleSave}
        isPending={upsertMutation.isPending}
      />
    </div>
  );
}
