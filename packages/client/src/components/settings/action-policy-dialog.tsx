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
import type { ActionMode, ParamMatcher } from '@valet/shared';

type AppliesIn = 'any' | 'workflow' | 'session';

const MATCHER_OPS: Array<{ id: ParamMatcher['op']; label: string; needsValue: boolean; valueHint?: string }> = [
  { id: 'eq', label: 'equals', needsValue: true },
  { id: 'neq', label: 'not equals', needsValue: true },
  { id: 'regex', label: 'matches regex', needsValue: true, valueHint: 'JavaScript regex without delimiters, e.g. ^1S2hM5' },
  { id: 'in', label: 'is one of', needsValue: true, valueHint: 'Comma-separated list' },
  { id: 'not_in', label: 'is not one of', needsValue: true, valueHint: 'Comma-separated list' },
  { id: 'gt', label: 'greater than', needsValue: true },
  { id: 'gte', label: 'greater than or equal', needsValue: true },
  { id: 'lt', label: 'less than', needsValue: true },
  { id: 'lte', label: 'less than or equal', needsValue: true },
  { id: 'exists', label: 'is set', needsValue: false },
  { id: 'not_exists', label: 'is missing', needsValue: false },
];

export interface EditableActionPolicy {
  id: string;
  service?: string | null;
  actionId?: string | null;
  riskLevel?: string | null;
  mode: ActionMode;
  appliesIn?: AppliesIn;
  paramMatchers?: ParamMatcher[];
}

interface ActionPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy?: EditableActionPolicy | null;
  noun?: string;
  /** When true, only the `allow` mode is offered. User-managed policies
   *  are allow-only per spec safety rule (the server rejects other
   *  modes), so the dialog hides them entirely instead of presenting
   *  buttons that submit and bounce. Admin-policy callers leave this
   *  off to keep require_approval / deny available. */
  allowOnly?: boolean;
  onSave: (data: {
    id: string;
    service?: string | null;
    actionId?: string | null;
    riskLevel?: string | null;
    mode: string;
    appliesIn?: AppliesIn;
    paramMatchers?: ParamMatcher[];
  }) => void;
  isPending?: boolean;
}

type PolicyScope = 'action' | 'service' | 'risk_level';

function inferScope(policy: EditableActionPolicy): PolicyScope {
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
                  <div className="truncate text-neutral-900 dark:text-neutral-100">{item.label}</div>
                  <div className="truncate font-mono text-[11px] text-neutral-400 dark:text-neutral-500">{item.id}</div>
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

// ─── Scope Row ───────────────────────────────────────────────────────────────

/**
 * Wraps each "Apply to" choice with its own inline picker so the form
 * reads like one continuous sentence. Inactive rows show just the
 * label; active row expands with its picker children.
 */
function ScopeRow({
  selected,
  onSelect,
  label,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 transition-colors',
        selected
          ? 'border-neutral-900 bg-neutral-50 dark:border-neutral-300 dark:bg-neutral-800/60'
          : 'border-neutral-200 dark:border-neutral-700',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-2 text-left text-sm"
      >
        <span
          className={cn(
            'h-3.5 w-3.5 shrink-0 rounded-full border',
            selected
              ? 'border-neutral-900 bg-neutral-900 dark:border-neutral-200 dark:bg-neutral-200'
              : 'border-neutral-300 dark:border-neutral-600',
          )}
        />
        <span
          className={cn(
            'font-medium',
            selected ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400',
          )}
        >
          {label}
        </span>
      </button>
      {selected && children}
    </div>
  );
}

// ─── Matcher List ────────────────────────────────────────────────────────────

const MATCHER_OPS_INTERNAL: Array<{ id: ParamMatcher['op']; label: string; needsValue: boolean; valueHint?: string }> = MATCHER_OPS;

function MatcherList({
  matchers,
  pathSuggestions,
  onChange,
  onRemove,
}: {
  matchers: ParamMatcher[];
  pathSuggestions: string[];
  onChange: (i: number, patch: Partial<ParamMatcher>) => void;
  onRemove: (i: number) => void;
}) {
  // datalist makes the suggestions native + free-text in the same input.
  const listId = React.useId();
  return (
    <div className="space-y-2">
      <datalist id={listId}>
        {pathSuggestions.map((p) => <option key={p} value={p} />)}
      </datalist>
      {matchers.map((m, i) => {
        const opDef = MATCHER_OPS_INTERNAL.find((o) => o.id === m.op);
        return (
          <div key={i} className="space-y-1.5 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={m.path}
                onChange={(e) => onChange(i, { path: e.target.value })}
                placeholder="param path"
                list={pathSuggestions.length > 0 ? listId : undefined}
                className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
              />
              <select
                value={m.op}
                onChange={(e) => onChange(i, { op: e.target.value as ParamMatcher['op'] })}
                className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-300"
              >
                {MATCHER_OPS_INTERNAL.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
              {opDef?.needsValue && (
                <ValueInput op={m.op} value={m.value} onChange={(v) => onChange(i, { value: v })} />
              )}
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="rounded p-1 text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
                aria-label="Remove condition"
              >
                ×
              </button>
            </div>
            {opDef?.valueHint && (
              <p className="text-[11px] text-neutral-500 dark:text-neutral-500">{opDef.valueHint}</p>
            )}
          </div>
        );
      })}
      <p className="text-[11px] text-neutral-500 dark:text-neutral-500">
        All conditions must match (AND).
      </p>
    </div>
  );
}

function ValueInput({
  op,
  value,
  onChange,
}: {
  op: ParamMatcher['op'];
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const display = Array.isArray(value)
    ? value.map(String).join(',')
    : value === undefined || value === null
      ? ''
      : String(value);
  return (
    <input
      type="text"
      value={display}
      onChange={(e) => {
        const raw = e.target.value;
        if (op === 'in' || op === 'not_in') {
          onChange(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
          return;
        }
        if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
          const n = Number(raw);
          onChange(Number.isFinite(n) && raw.trim().length > 0 ? n : raw);
          return;
        }
        onChange(raw);
      }}
      placeholder="value"
      className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
    />
  );
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

export function ActionPolicyDialog({ open, onOpenChange, policy, noun = 'Policy', allowOnly = false, onSave, isPending }: ActionPolicyDialogProps) {
  const [scope, setScope] = React.useState<PolicyScope>('action');
  const [service, setService] = React.useState('');
  const [actionId, setActionId] = React.useState('');
  const [riskLevel, setRiskLevel] = React.useState('medium');
  const [mode, setMode] = React.useState<ActionMode>(allowOnly ? 'allow' : 'require_approval');
  const [appliesIn, setAppliesIn] = React.useState<AppliesIn>('any');
  const [matchers, setMatchers] = React.useState<ParamMatcher[]>([]);
  const [showJson, setShowJson] = React.useState(false);

  const { data: catalog } = useActionCatalog();

  // Reset form when dialog opens/policy changes. Depending on `policy`
  // (the object) re-fires this effect on every render because the
  // parent passes a fresh-derived object each time (toEditablePolicy
  // returns a new ref), which would overwrite the user's in-progress
  // edits between keystrokes. Key on the stable id + open instead.
  const policyId = policy?.id ?? null;
  React.useEffect(() => {
    if (policy) {
      setScope(inferScope(policy));
      setService(policy.service || '');
      setActionId(policy.actionId || '');
      setRiskLevel(policy.riskLevel || 'medium');
      setMode(policy.mode);
      setAppliesIn(policy.appliesIn ?? 'any');
      setMatchers(policy.paramMatchers ?? []);
    } else {
      setScope('action');
      setService('');
      setActionId('');
      setRiskLevel('medium');
      setMode(allowOnly ? 'allow' : 'require_approval');
      setAppliesIn('any');
      setMatchers([]);
    }
    setShowJson(false);
    // policyId + open captures "switched policies" or "reopened" — the
    // two cases we actually want to reset on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyId, open]);

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

  // Derived: path autocomplete suggestions for matcher rows. When the
  // user has picked a specific action whose inputSchema lists named
  // properties, surface those as suggestions so they don't have to know
  // the field name is `spreadsheetId` from documentation. Falls back to
  // empty (free-text only) when the catalog has no schema.
  const pathSuggestions = React.useMemo<string[]>(() => {
    if (!catalog || !service || !actionId) return [];
    const entry = catalog.find((e) => e.service === service && e.actionId === actionId);
    const schema = entry?.inputSchema;
    if (!schema || typeof schema !== 'object') return [];
    const props = (schema as Record<string, unknown>).properties;
    if (!props || typeof props !== 'object') return [];
    return Object.keys(props as Record<string, unknown>);
  }, [catalog, service, actionId]);

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
      appliesIn?: AppliesIn;
      paramMatchers?: ParamMatcher[];
    } = { id, mode, appliesIn, paramMatchers: matchers.filter((m) => m.path.trim().length > 0) };

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

  function updateMatcher(i: number, patch: Partial<ParamMatcher>) {
    setMatchers((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addMatcher() {
    setMatchers((rows) => [...rows, { path: '', op: 'eq', value: '' }]);
  }
  function removeMatcher(i: number) {
    setMatchers((rows) => rows.filter((_, idx) => idx !== i));
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle>
              {allowOnly
                ? (policy ? 'Edit auto-approval rule' : 'Auto-approve…')
                : (policy ? `Edit ${noun}` : `Add ${noun}`)}
            </DialogTitle>
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
            {/* Apply to — scope picker. Each option includes its inline
                picker (action vs service vs risk level) so the form
                reads as one sentence instead of three radio + three
                separate input sections. */}
            <section>
              <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Apply to
              </label>
              <div className="space-y-2">
                <ScopeRow
                  selected={scope === 'action'}
                  onSelect={() => handleScopeChange('action')}
                  label="A specific action"
                >
                  <div className="mt-2 space-y-2">
                    <TypeaheadCombobox
                      items={serviceItems}
                      value={service}
                      onChange={handleServiceChange}
                      placeholder="Service"
                      allowFreeText
                    />
                    <TypeaheadCombobox
                      items={actionItems}
                      value={actionId}
                      onChange={setActionId}
                      placeholder={service ? 'Action' : 'Pick a service first'}
                      disabled={!service}
                      allowFreeText
                    />
                  </div>
                </ScopeRow>
                <ScopeRow
                  selected={scope === 'service'}
                  onSelect={() => handleScopeChange('service')}
                  label="Any action in a service"
                >
                  <div className="mt-2">
                    <TypeaheadCombobox
                      items={serviceItems}
                      value={service}
                      onChange={handleServiceChange}
                      placeholder="Service"
                      allowFreeText
                    />
                  </div>
                </ScopeRow>
                <ScopeRow
                  selected={scope === 'risk_level'}
                  onSelect={() => handleScopeChange('risk_level')}
                  label="Any action of a risk level"
                >
                  <div className="mt-2">
                    <RiskLevelCards value={riskLevel} onChange={setRiskLevel} />
                  </div>
                </ScopeRow>
              </div>
            </section>

            {/* Effect — only rendered for admin-mode policies. User
                policies are allow-only; showing a one-option section
                with a paragraph explaining why is dead UI, so we drop
                it entirely there. */}
            {!allowOnly && (
              <section>
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
              </section>
            )}

            {/* When — first-class param-condition editor. Each row
                renders the path field with autocomplete from the
                selected action's inputSchema; disabled for service /
                risk-level scopes where conditions can't safely apply
                across actions with different param shapes. */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">When</label>
                {scope === 'action' && (
                  <button
                    type="button"
                    onClick={addMatcher}
                    className="text-xs text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                  >
                    + add condition
                  </button>
                )}
              </div>
              {scope !== 'action' ? (
                <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
                  Conditions only apply to specific actions — different actions in a service (or at a risk level) have different parameters.
                  Switch to <em>A specific action</em> to add conditions.
                </p>
              ) : matchers.length === 0 ? (
                <p className="text-xs text-neutral-500 dark:text-neutral-500">
                  No conditions — the rule fires for any params. Add one like <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">spreadsheetId equals 1S2hM5…</code> to scope to a single target.
                </p>
              ) : (
                <MatcherList
                  matchers={matchers}
                  pathSuggestions={pathSuggestions}
                  onChange={updateMatcher}
                  onRemove={removeMatcher}
                />
              )}
            </section>

            {/* In — context filter. Top-level (not buried under
                Advanced) so the user sees it as part of the rule's
                shape, not an afterthought. */}
            <section>
              <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">In</label>
              <div className="flex gap-2">
                {(['any', 'session', 'workflow'] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setAppliesIn(opt)}
                    className={cn(
                      'flex-1 rounded-md border px-2 py-1.5 text-sm transition-colors',
                      appliesIn === opt
                        ? 'border-neutral-900 bg-neutral-50 dark:border-neutral-300 dark:bg-neutral-800'
                        : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600',
                    )}
                  >
                    {opt === 'any' ? 'Anywhere' : opt === 'session' ? 'Chat sessions only' : 'Workflow runs only'}
                  </button>
                ))}
              </div>
            </section>

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
