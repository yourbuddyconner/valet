import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useRuntimeGrants, useRevokeRuntimeGrant, type RuntimeGrant } from '@/api/runtime-grants';
import { useActionCatalog } from '@/api/action-catalog';
import type { ActionCatalogEntry } from '@/api/action-catalog';
import { formatRelativeTime } from '@/lib/format';

function scopeBadge(grant: RuntimeGrant): { label: string; variant: 'default' | 'secondary' } {
  if (grant.sessionId) return { label: 'Session', variant: 'default' };
  if (grant.workflowExecutionId) return { label: 'Workflow run', variant: 'secondary' };
  return { label: 'Unknown', variant: 'secondary' };
}

function targetLabel(grant: RuntimeGrant, catalog: ActionCatalogEntry[] | undefined): React.ReactNode {
  if (grant.service && grant.actionId) {
    const entry = catalog?.find((e) => e.service === grant.service && e.actionId === grant.actionId);
    return (
      <span className="flex items-baseline gap-1.5">
        {entry ? (
          <>
            <span className="text-neutral-900 dark:text-neutral-100">{entry.serviceDisplayName} &rsaquo; {entry.name}</span>
            <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">{grant.actionId}</span>
          </>
        ) : (
          <span className="font-mono">{grant.service}:{grant.actionId}</span>
        )}
      </span>
    );
  }
  if (grant.service) {
    const entry = catalog?.find((e) => e.service === grant.service);
    return <span>{entry?.serviceDisplayName ?? grant.service}</span>;
  }
  if (grant.riskLevel) return <span>Risk level: {grant.riskLevel}</span>;
  return <span className="text-neutral-400">—</span>;
}

function contextLink(grant: RuntimeGrant): React.ReactNode {
  if (grant.sessionId) {
    return (
      <a
        href={`/sessions/${grant.sessionId}`}
        className="font-mono text-xs text-amber-700 underline hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
        title="Open the session this grant lives on"
      >
        {grant.sessionId.slice(0, 8)}…
      </a>
    );
  }
  if (grant.workflowExecutionId) {
    return (
      <a
        href={`/automation/executions/${grant.workflowExecutionId}`}
        className="font-mono text-xs text-amber-700 underline hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
        title="Open the workflow execution this grant lives on"
      >
        {grant.workflowExecutionId.slice(0, 8)}…
      </a>
    );
  }
  return null;
}

export function RuntimeGrantsSection() {
  const { data: grants, isLoading } = useRuntimeGrants();
  const { data: catalog } = useActionCatalog();
  const revoke = useRevokeRuntimeGrant();

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
      <div>
        <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">Active runtime grants</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Ephemeral approvals from <em>Allow for Session</em> and <em>Approve for this run</em>. They auto-expire when the
          session or workflow run terminates — revoke here to clear them sooner.
        </p>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : !grants || grants.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No active runtime grants.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-700">
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Scope</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Target</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Context</th>
                <th className="pb-2 text-left font-medium text-neutral-500 dark:text-neutral-400">Granted</th>
                <th className="pb-2 text-right font-medium text-neutral-500 dark:text-neutral-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => {
                const scope = scopeBadge(grant);
                return (
                  <tr key={grant.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-700/50">
                    <td className="py-2">
                      <Badge variant={scope.variant}>{scope.label}</Badge>
                    </td>
                    <td className="py-2 text-xs">{targetLabel(grant, catalog)}</td>
                    <td className="py-2">{contextLink(grant)}</td>
                    <td className="py-2 text-xs text-neutral-500 dark:text-neutral-400">
                      {formatRelativeTime(grant.createdAt)}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => revoke.mutate(grant.id)}
                        disabled={revoke.isPending}
                        className="text-red-600 hover:text-red-700 dark:text-red-400"
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
