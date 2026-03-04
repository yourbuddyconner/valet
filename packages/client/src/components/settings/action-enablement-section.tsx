import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { useActionCatalog } from '@/api/action-catalog';
import type { ActionCatalogEntry } from '@/api/action-catalog';
import { useDisabledActions, useSetServiceDisabledState } from '@/api/disabled-actions';
import type { DisabledAction } from '@agent-ops/shared';

interface ServiceGroup {
  service: string;
  displayName: string;
  actions: ActionCatalogEntry[];
}

function riskBadgeVariant(risk: string): 'success' | 'warning' | 'error' | 'secondary' {
  switch (risk) {
    case 'low': return 'success';
    case 'medium': return 'warning';
    case 'high': return 'error';
    case 'critical': return 'error';
    default: return 'secondary';
  }
}

function groupByService(catalog: ActionCatalogEntry[]): ServiceGroup[] {
  const map = new Map<string, ServiceGroup>();
  for (const entry of catalog) {
    let group = map.get(entry.service);
    if (!group) {
      group = { service: entry.service, displayName: entry.serviceDisplayName, actions: [] };
      map.set(entry.service, group);
    }
    group.actions.push(entry);
  }
  return Array.from(map.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function buildDisabledIndex(rows: DisabledAction[]) {
  const disabledServices = new Set<string>();
  const disabledActions = new Set<string>();
  for (const row of rows) {
    if (row.actionId) {
      disabledActions.add(`${row.service}:${row.actionId}`);
    } else {
      disabledServices.add(row.service);
    }
  }
  return { disabledServices, disabledActions };
}

export function ActionEnablementSection() {
  const { data: catalog, isLoading: catalogLoading } = useActionCatalog();
  const { data: disabledRows, isLoading: disabledLoading } = useDisabledActions();
  const setStateMutation = useSetServiceDisabledState();
  const [expandedServices, setExpandedServices] = React.useState<Set<string>>(new Set());

  const isLoading = catalogLoading || disabledLoading;

  const groups = React.useMemo(
    () => (catalog ? groupByService(catalog) : []),
    [catalog],
  );

  const { disabledServices, disabledActions } = React.useMemo(
    () => buildDisabledIndex(disabledRows ?? []),
    [disabledRows],
  );

  function toggleExpand(service: string) {
    setExpandedServices((prev) => {
      const next = new Set(prev);
      if (next.has(service)) next.delete(service);
      else next.add(service);
      return next;
    });
  }

  function handleServiceToggle(group: ServiceGroup, currentlyEnabled: boolean) {
    if (currentlyEnabled) {
      // Disabling entire service
      setStateMutation.mutate({
        service: group.service,
        serviceDisabled: true,
        disabledActionIds: [],
      });
    } else {
      // Re-enabling entire service (clear all disabled rows)
      setStateMutation.mutate({
        service: group.service,
        serviceDisabled: false,
        disabledActionIds: [],
      });
    }
  }

  function handleActionToggle(group: ServiceGroup, actionId: string, currentlyEnabled: boolean) {
    // Compute the new set of disabled action IDs for this service
    const currentDisabledForService = (disabledRows ?? [])
      .filter((r) => r.service === group.service && r.actionId)
      .map((r) => r.actionId!);

    let newDisabled: string[];
    if (currentlyEnabled) {
      // Disabling this action
      newDisabled = [...currentDisabledForService, actionId];
    } else {
      // Re-enabling this action
      newDisabled = currentDisabledForService.filter((id) => id !== actionId);
    }

    setStateMutation.mutate({
      service: group.service,
      serviceDisabled: false,
      disabledActionIds: newDisabled,
    });
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
      <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">Action Enablement</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Globally enable or disable integration actions. Disabled actions are hidden from agent tool discovery and blocked at invocation.
      </p>

      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No integration actions discovered yet. Connect an integration to see available actions.
          </p>
        ) : (
          <div className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-700 dark:border-neutral-700">
            {groups.map((group) => {
              const isServiceDisabled = disabledServices.has(group.service);
              const disabledActionCount = group.actions.filter(
                (a) => disabledActions.has(`${group.service}:${a.actionId}`),
              ).length;
              const allEnabled = !isServiceDisabled && disabledActionCount === 0;
              const someDisabled = !isServiceDisabled && disabledActionCount > 0;
              const isExpanded = expandedServices.has(group.service);

              return (
                <div key={group.service}>
                  {/* Service row */}
                  <div className="flex items-center gap-3 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={!isServiceDisabled && disabledActionCount === 0}
                      ref={(el) => {
                        if (el) el.indeterminate = someDisabled;
                      }}
                      onChange={() => handleServiceToggle(group, allEnabled || someDisabled)}
                      disabled={setStateMutation.isPending}
                      className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40 dark:border-neutral-600"
                    />
                    <button
                      type="button"
                      onClick={() => toggleExpand(group.service)}
                      className="flex flex-1 items-center gap-2 text-left"
                    >
                      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {group.displayName}
                      </span>
                      <span className="text-xs text-neutral-400 dark:text-neutral-500">
                        {group.actions.length} action{group.actions.length !== 1 ? 's' : ''}
                      </span>
                      {isServiceDisabled && (
                        <Badge variant="error">Disabled</Badge>
                      )}
                      {someDisabled && (
                        <Badge variant="warning">{disabledActionCount} disabled</Badge>
                      )}
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`ml-auto h-4 w-4 text-neutral-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  </div>

                  {/* Expanded action list */}
                  {isExpanded && (
                    <div className="border-t border-neutral-100 bg-neutral-50 dark:border-neutral-700/50 dark:bg-neutral-800/50">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-neutral-200 dark:border-neutral-700">
                            <th className="w-10 px-4 py-1.5" />
                            <th className="px-2 py-1.5 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400">Action</th>
                            <th className="px-2 py-1.5 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400">Description</th>
                            <th className="px-4 py-1.5 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400">Risk</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.actions.map((action) => {
                            const compositeKey = `${group.service}:${action.actionId}`;
                            const actionEnabled = !isServiceDisabled && !disabledActions.has(compositeKey);

                            return (
                              <tr key={action.actionId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-700/50">
                                <td className="px-4 py-2">
                                  <input
                                    type="checkbox"
                                    checked={actionEnabled}
                                    disabled={isServiceDisabled || setStateMutation.isPending}
                                    onChange={() => handleActionToggle(group, action.actionId, actionEnabled)}
                                    className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40 dark:border-neutral-600"
                                  />
                                </td>
                                <td className="px-2 py-2">
                                  <span className={`text-sm ${actionEnabled ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-400 line-through dark:text-neutral-500'}`}>
                                    {action.name}
                                  </span>
                                </td>
                                <td className="px-2 py-2">
                                  <span className="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-1">
                                    {action.description}
                                  </span>
                                </td>
                                <td className="px-4 py-2">
                                  <Badge variant={riskBadgeVariant(action.riskLevel)}>
                                    {action.riskLevel}
                                  </Badge>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
