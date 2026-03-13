import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { useActionCatalog } from '@/api/action-catalog';
import type { ActionPolicy, ActionMode } from '@valet/shared';

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

function inferScope(policy: ActionPolicy): PolicyScope {
  if (policy.actionId) return 'action';
  if (policy.service) return 'service';
  return 'risk_level';
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const riskColors: Record<string, { bg: string; text: string; dot: string }> = {
  low: { bg: 'bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
  medium: { bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  high: { bg: 'bg-orange-500/10', text: 'text-orange-600 dark:text-orange-400', dot: 'bg-orange-500' },
  critical: { bg: 'bg-red-500/10', text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500' },
};

// ─── Radio Card ───────────────────────────────────────────────────────────────

function RadioCard({
  selected,
  onClick,
  label,
  description,
  className,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  description?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 flex-col rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
        selected
          ? 'border-neutral-900 bg-neutral-50 dark:border-neutral-300 dark:bg-neutral-800'
          : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-700 dark:hover:border-neutral-600',
        className,
      )}
    >
      <span
        className={cn(
          'font-medium',
          selected
            ? 'text-neutral-900 dark:text-neutral-100'
            : 'text-neutral-600 dark:text-neutral-400',
        )}
      >
        {label}
      </span>
      {description && (
        <span className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-500">
          {description}
        </span>
      )}
    </button>
  );
}

// ─── Mode Card (colored) ─────────────────────────────────────────────────────

function ModeCard({
  selected,
  onClick,
  label,
  description,
  colorClass,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  description: string;
  colorClass: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 flex-col rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
        selected ? colorClass : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-700 dark:hover:border-neutral-600',
      )}
    >
      <span
        className={cn(
          'font-medium',
          selected ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-600 dark:text-neutral-400',
        )}
      >
        {label}
      </span>
      <span className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-500">
        {description}
      </span>
    </button>
  );
}

// ─── Typeahead Combobox ───────────────────────────────────────────────────────

interface TypeaheadItem {
  id: string;
  label: string;
  sublabel?: string;
  badge?: string;
  badgeColor?: string;
  description?: string;
}

function TypeaheadCombobox({
  items,
  value,
  onChange,
  placeholder,
  disabled,
  renderItem,
  allowFreeText,
  freeTextHint,
}: {
  items: TypeaheadItem[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  disabled?: boolean;
  renderItem?: (item: TypeaheadItem, highlighted: boolean) => React.ReactNode;
  /** When true, the user can type a custom value that isn't in the list. */
  allowFreeText?: boolean;
  /** Hint text shown below the input when free-text is enabled. */
  freeTextHint?: string;
}) {
  const [query, setQuery] = React.useState('');
  const [showDropdown, setShowDropdown] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  // Display the selected item's label (or the raw value if not in the list)
  const selectedItem = items.find((i) => i.id === value);

  const filtered = React.useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q) ||
        (i.description?.toLowerCase().includes(q)),
    );
  }, [query, items]);

  // Whether the current query text is an exact match to an existing item
  const queryMatchesItem = React.useMemo(() => {
    const q = query.trim();
    if (!q) return false;
    return items.some((i) => i.id === q || i.label.toLowerCase() === q.toLowerCase());
  }, [query, items]);

  // Show "Use custom value" option when free text is enabled and query doesn't match existing items
  const showFreeTextOption = allowFreeText && query.trim() && !queryMatchesItem;

  // Total selectable items in the dropdown (filtered + optional free-text entry)
  const totalDropdownItems = filtered.length + (showFreeTextOption ? 1 : 0);

  // Reset highlight when filtered list changes
  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [filtered.length, showFreeTextOption]);

  // Scroll highlighted item into view
  React.useEffect(() => {
    if (!showDropdown || !dropdownRef.current) return;
    const item = dropdownRef.current.children[highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, showDropdown]);

  // Click-outside dismiss — commit free-text on blur if applicable
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) {
        // If user typed a free-text value and clicked away, commit it
        if (allowFreeText && query.trim() && !queryMatchesItem) {
          onChange(query.trim());
          setQuery('');
        }
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [allowFreeText, query, queryMatchesItem, onChange]);

  function handleSelect(id: string) {
    onChange(id);
    setQuery('');
    setShowDropdown(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setShowDropdown(false);
      return;
    }

    if (!showDropdown || totalDropdownItems === 0) {
      // Allow Enter to commit free-text even when dropdown is not shown
      if (e.key === 'Enter' && allowFreeText && query.trim()) {
        e.preventDefault();
        handleSelect(query.trim());
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, totalDropdownItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (showFreeTextOption && highlightedIndex === filtered.length) {
          // Free-text option is highlighted
          handleSelect(query.trim());
        } else if (filtered[highlightedIndex]) {
          handleSelect(filtered[highlightedIndex].id);
        }
        break;
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={showDropdown ? query : (selectedItem?.label ?? value)}
        onChange={(e) => {
          setQuery(e.target.value);
          setShowDropdown(true);
        }}
        onFocus={() => {
          setQuery('');
          setShowDropdown(true);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          'block w-full rounded-md border px-3 py-2 text-sm transition-colors',
          'border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-400',
          'focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500',
          'dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500',
          'dark:focus:border-neutral-400 dark:focus:ring-neutral-400',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      />
      {allowFreeText && freeTextHint && !showDropdown && !value && (
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">{freeTextHint}</p>
      )}
      {value && !showDropdown && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            setQuery('');
            inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>
      )}
      {showDropdown && (filtered.length > 0 || showFreeTextOption) && (
        <div
          ref={dropdownRef}
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
        >
          {filtered.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(item.id);
              }}
              onMouseEnter={() => setHighlightedIndex(i)}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-2 text-left text-sm',
                i === highlightedIndex
                  ? 'bg-neutral-100 dark:bg-neutral-700'
                  : 'hover:bg-neutral-50 dark:hover:bg-neutral-700/50',
              )}
            >
              {renderItem ? (
                renderItem(item, i === highlightedIndex)
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-neutral-900 dark:text-neutral-100">{item.label}</span>
                    <span className="shrink-0 font-mono text-[11px] text-neutral-400 dark:text-neutral-500">{item.id}</span>
                  </div>
                  {item.description && (
                    <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{item.description}</div>
                  )}
                </div>
              )}
              {item.badge && (
                <span className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                  item.badgeColor || 'bg-neutral-100 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400',
                )}>
                  {item.badge}
                </span>
              )}
            </button>
          ))}
          {showFreeTextOption && (
            <button
              key="__free_text__"
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(query.trim());
              }}
              onMouseEnter={() => setHighlightedIndex(filtered.length)}
              className={cn(
                'flex w-full items-center gap-2 border-t border-neutral-100 px-3 py-2 text-left text-sm dark:border-neutral-700',
                highlightedIndex === filtered.length
                  ? 'bg-neutral-100 dark:bg-neutral-700'
                  : 'hover:bg-neutral-50 dark:hover:bg-neutral-700/50',
              )}
            >
              <span className="text-neutral-500 dark:text-neutral-400">Use</span>
              <span className="font-mono text-neutral-900 dark:text-neutral-100">{query.trim()}</span>
            </button>
          )}
        </div>
      )}
      {showDropdown && filtered.length === 0 && query && !allowFreeText && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-500 shadow-lg dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
          No results for &ldquo;{query}&rdquo;
        </div>
      )}
    </div>
  );
}

// ─── Risk Level Radio Cards ──────────────────────────────────────────────────

function RiskLevelCards({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const levels = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'critical', label: 'Critical' },
  ] as const;

  return (
    <div className="grid grid-cols-4 gap-2">
      {levels.map((level) => {
        const colors = riskColors[level.id];
        const selected = value === level.id;
        return (
          <button
            key={level.id}
            type="button"
            onClick={() => onChange(level.id)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
              selected
                ? `${colors.bg} ${colors.text} border-current`
                : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600',
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', selected ? colors.dot : 'bg-neutral-300 dark:bg-neutral-600')} />
            {level.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── JSON View ───────────────────────────────────────────────────────────────

function PolicyJsonView({
  scope,
  service,
  actionId,
  riskLevel,
  mode,
}: {
  scope: PolicyScope;
  service: string;
  actionId: string;
  riskLevel: string;
  mode: string;
}) {
  const obj: Record<string, string | null> = {};
  switch (scope) {
    case 'action':
      obj.service = service || null;
      obj.actionId = actionId || null;
      obj.riskLevel = null;
      break;
    case 'service':
      obj.service = service || null;
      obj.actionId = null;
      obj.riskLevel = null;
      break;
    case 'risk_level':
      obj.service = null;
      obj.actionId = null;
      obj.riskLevel = riskLevel || null;
      break;
  }
  obj.mode = mode;

  return (
    <pre className="overflow-auto rounded-lg border border-neutral-200 bg-neutral-950 p-4 text-[13px] leading-relaxed text-neutral-300 dark:border-neutral-700">
      {JSON.stringify(obj, null, 2)}
    </pre>
  );
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

export function ActionPolicyDialog({ open, onOpenChange, policy, onSave, isPending }: ActionPolicyDialogProps) {
  const [scope, setScope] = React.useState<PolicyScope>('action');
  const [service, setService] = React.useState('');
  const [actionId, setActionId] = React.useState('');
  const [riskLevel, setRiskLevel] = React.useState('medium');
  const [mode, setMode] = React.useState<ActionMode>('require_approval');
  const [showJson, setShowJson] = React.useState(false);

  const { data: catalog } = useActionCatalog();

  // Reset form when dialog opens/policy changes
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
    setShowJson(false);
  }, [policy, open]);

  // Derived: unique services from catalog
  const serviceItems = React.useMemo<TypeaheadItem[]>(() => {
    if (!catalog) return [];
    const serviceMap = new Map<string, { displayName: string; count: number }>();
    for (const entry of catalog) {
      const existing = serviceMap.get(entry.service);
      if (existing) {
        existing.count++;
      } else {
        serviceMap.set(entry.service, { displayName: entry.serviceDisplayName, count: 1 });
      }
    }
    return Array.from(serviceMap.entries()).map(([id, info]) => ({
      id,
      label: info.displayName,
      badge: `${info.count} actions`,
    }));
  }, [catalog]);

  // Derived: actions for selected service
  const actionItems = React.useMemo<TypeaheadItem[]>(() => {
    if (!catalog || !service) return [];
    return catalog
      .filter((e) => e.service === service)
      .map((e) => {
        const colors = riskColors[e.riskLevel];
        return {
          id: e.actionId,
          label: e.name,
          description: e.description,
          badge: e.riskLevel,
          badgeColor: colors ? `${colors.bg} ${colors.text}` : undefined,
        };
      });
  }, [catalog, service]);

  function handleScopeChange(newScope: PolicyScope) {
    setScope(newScope);
    if (newScope === 'risk_level') {
      setService('');
      setActionId('');
    }
    if (newScope === 'service') {
      setActionId('');
    }
  }

  function handleServiceChange(newService: string) {
    setService(newService);
    setActionId(''); // clear action when service changes
  }

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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle>{policy ? 'Edit Policy' : 'Add Policy'}</DialogTitle>
            <button
              type="button"
              onClick={() => setShowJson((v) => !v)}
              className={cn(
                'rounded-md border px-2 py-1 font-mono text-xs transition-colors',
                showJson
                  ? 'border-neutral-900 bg-neutral-900 text-neutral-100 dark:border-neutral-300 dark:bg-neutral-300 dark:text-neutral-900'
                  : 'border-neutral-300 text-neutral-500 hover:border-neutral-400 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-neutral-500',
              )}
            >
              {'{ }'}
            </button>
          </div>
        </DialogHeader>

        {showJson ? (
          <div className="space-y-4">
            <PolicyJsonView
              scope={scope}
              service={service}
              actionId={actionId}
              riskLevel={riskLevel}
              mode={mode}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowJson(false)}>
                Back to editor
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Scope selector */}
            <div>
              <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Scope
              </label>
              <div className="flex gap-2">
                <RadioCard
                  selected={scope === 'action'}
                  onClick={() => handleScopeChange('action')}
                  label="Specific Action"
                  description="Target a single action"
                />
                <RadioCard
                  selected={scope === 'service'}
                  onClick={() => handleScopeChange('service')}
                  label="Entire Service"
                  description="All actions in a service"
                />
                <RadioCard
                  selected={scope === 'risk_level'}
                  onClick={() => handleScopeChange('risk_level')}
                  label="Risk Level"
                  description="By risk classification"
                />
              </div>
            </div>

            {/* Service typeahead */}
            {(scope === 'action' || scope === 'service') && (
              <div>
                <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Service
                </label>
                <TypeaheadCombobox
                  items={serviceItems}
                  value={service}
                  onChange={handleServiceChange}
                  placeholder="Search services or type a name..."
                  allowFreeText
                  freeTextHint="Type a service name like &quot;linear&quot; if it doesn't appear in the list"
                />
              </div>
            )}

            {/* Action typeahead */}
            {scope === 'action' && (
              <div>
                <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Action
                </label>
                <TypeaheadCombobox
                  items={actionItems}
                  value={actionId}
                  onChange={setActionId}
                  placeholder={service ? 'Search actions or type an ID...' : 'Select a service first'}
                  disabled={!service}
                  allowFreeText
                  freeTextHint="Type an action ID like &quot;linear.save_issue&quot; if it doesn't appear"
                />
              </div>
            )}

            {/* Risk level radio cards */}
            {scope === 'risk_level' && (
              <div>
                <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Risk Level
                </label>
                <RiskLevelCards value={riskLevel} onChange={setRiskLevel} />
              </div>
            )}

            {/* Mode selector */}
            <div>
              <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Effect
              </label>
              <div className="flex gap-2">
                <ModeCard
                  selected={mode === 'allow'}
                  onClick={() => setMode('allow')}
                  label="Allow"
                  description="Execute without approval"
                  colorClass="border-emerald-500 bg-emerald-500/5 dark:border-emerald-400 dark:bg-emerald-500/10"
                />
                <ModeCard
                  selected={mode === 'require_approval'}
                  onClick={() => setMode('require_approval')}
                  label="Require Approval"
                  description="Pause and ask user first"
                  colorClass="border-amber-500 bg-amber-500/5 dark:border-amber-400 dark:bg-amber-500/10"
                />
                <ModeCard
                  selected={mode === 'deny'}
                  onClick={() => setMode('deny')}
                  label="Deny"
                  description="Block execution entirely"
                  colorClass="border-red-500 bg-red-500/5 dark:border-red-400 dark:bg-red-500/10"
                />
              </div>
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
        )}
      </DialogContent>
    </Dialog>
  );
}
