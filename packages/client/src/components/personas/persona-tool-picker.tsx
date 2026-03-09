import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { useActionCatalog } from '@/api/action-catalog';
import type { ActionCatalogEntry } from '@/api/action-catalog';
import { useDisabledActions } from '@/api/disabled-actions';
import type { DisabledAction } from '@valet/shared';

interface ToolEntry {
  service: string;
  actionId?: string;
  enabled: boolean;
}

export interface PersonaToolPickerProps {
  tools: ToolEntry[];
  onChange: (tools: ToolEntry[]) => void;
}

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

/**
 * Build an index of org-level disabled services and actions from the disabled_actions table.
 */
function buildOrgDisabledIndex(rows: DisabledAction[]) {
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

/**
 * PersonaToolPicker — lets users configure which integration tools a persona has access to
 * using service-level toggles with action-level overrides.
 *
 * Behavior:
 * - Service toggled ON: adds `{ service, enabled: true }` (all actions implicitly enabled)
 * - Service toggled OFF: removes all entries for that service
 * - Action toggled OFF within enabled service: adds `{ service, actionId, enabled: false }`
 * - Action toggled back ON: removes the `{ service, actionId, enabled: false }` entry
 */
export function PersonaToolPicker({ tools, onChange }: PersonaToolPickerProps) {
  const { data: catalog, isLoading: catalogLoading } = useActionCatalog();
  const { data: disabledRows, isLoading: disabledLoading } = useDisabledActions();
  const [expandedServices, setExpandedServices] = React.useState<Set<string>>(new Set());

  const isLoading = catalogLoading || disabledLoading;

  const { disabledServices: orgDisabledServices, disabledActions: orgDisabledActions } = React.useMemo(
    () => buildOrgDisabledIndex(disabledRows ?? []),
    [disabledRows],
  );

  // Filter catalog to only include actions not denied at org level, and services not denied at org level
  const groups = React.useMemo(() => {
    if (!catalog) return [];
    const filtered = catalog.filter((entry) => {
      if (orgDisabledServices.has(entry.service)) return false;
      if (orgDisabledActions.has(`${entry.service}:${entry.actionId}`)) return false;
      return true;
    });
    return groupByService(filtered);
  }, [catalog, orgDisabledServices, orgDisabledActions]);

  // Build indexes from the current tools prop for quick lookup
  const { enabledServices, disabledActionOverrides } = React.useMemo(() => {
    const enabled = new Set<string>();
    const overrides = new Set<string>();
    for (const t of tools) {
      if (!t.actionId && t.enabled) {
        enabled.add(t.service);
      }
      if (t.actionId && !t.enabled) {
        overrides.add(`${t.service}:${t.actionId}`);
      }
    }
    return { enabledServices: enabled, disabledActionOverrides: overrides };
  }, [tools]);

  function toggleExpand(service: string) {
    setExpandedServices((prev) => {
      const next = new Set(prev);
      if (next.has(service)) next.delete(service);
      else next.add(service);
      return next;
    });
  }

  function handleServiceToggle(service: string) {
    const isCurrentlyEnabled = enabledServices.has(service);
    if (isCurrentlyEnabled) {
      // Toggling OFF: remove all entries for this service
      onChange(tools.filter((t) => t.service !== service));
    } else {
      // Toggling ON: add service-level entry, remove any stale entries for this service
      const withoutService = tools.filter((t) => t.service !== service);
      onChange([...withoutService, { service, enabled: true }]);
    }
  }

  function handleActionToggle(service: string, actionId: string) {
    const compositeKey = `${service}:${actionId}`;
    const isCurrentlyDisabled = disabledActionOverrides.has(compositeKey);

    if (isCurrentlyDisabled) {
      // Re-enabling: remove the override entry
      onChange(tools.filter((t) => !(t.service === service && t.actionId === actionId)));
    } else {
      // Disabling: add an override entry
      onChange([...tools, { service, actionId, enabled: false }]);
    }
  }

  const hasEnabledServices = enabledServices.size > 0;

  return (
    <div>
      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No integration actions available. Connect an integration to see available tools.
          </p>
        ) : (
          <>
            {!hasEnabledServices && (
              <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
                No tools enabled. This persona will only have built-in coding tools.
              </p>
            )}
            <div className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-700 dark:border-neutral-700">
              {groups.map((group) => {
                const isServiceEnabled = enabledServices.has(group.service);
                const disabledActionCount = isServiceEnabled
                  ? group.actions.filter(
                      (a) => disabledActionOverrides.has(`${group.service}:${a.actionId}`),
                    ).length
                  : 0;
                const someActionsDisabled = isServiceEnabled && disabledActionCount > 0;
                const isExpanded = expandedServices.has(group.service);

                return (
                  <div key={group.service}>
                    {/* Service row */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isServiceEnabled}
                        ref={(el) => {
                          if (el) el.indeterminate = someActionsDisabled;
                        }}
                        onChange={() => handleServiceToggle(group.service)}
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
                        {!isServiceEnabled && (
                          <Badge variant="secondary">Off</Badge>
                        )}
                        {someActionsDisabled && (
                          <Badge variant="warning">{disabledActionCount} excluded</Badge>
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
                              const actionEnabled = isServiceEnabled && !disabledActionOverrides.has(compositeKey);

                              return (
                                <tr key={action.actionId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-700/50">
                                  <td className="px-4 py-2">
                                    <input
                                      type="checkbox"
                                      checked={actionEnabled}
                                      disabled={!isServiceEnabled}
                                      onChange={() => handleActionToggle(group.service, action.actionId)}
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
          </>
        )}
      </div>
    </div>
  );
}
