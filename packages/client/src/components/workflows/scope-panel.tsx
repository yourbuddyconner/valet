import { useState, type ReactElement } from 'react';
import type { Scope, ScopeField, ScopeFieldType } from './scope-inferencer';

interface Props {
  scope: Scope;
  /** Called when the user clicks a leaf field; the path is the dot-path string e.g. "variables.name" or "outputs.foo.bar". */
  onInsertPath?: (path: string) => void;
}

// Color palette per type — chosen so each type is visually distinct at a glance.
const TYPE_BADGE: Record<ScopeFieldType, string> = {
  string: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  number: 'bg-blue-100 text-blue-700 border-blue-200',
  boolean: 'bg-blue-100 text-blue-700 border-blue-200',
  array: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200',
  object: 'bg-amber-100 text-amber-700 border-amber-200',
  unknown: 'bg-neutral-100 text-neutral-600 border-neutral-200',
};

function TypeBadge({ type }: { type: ScopeFieldType }) {
  return (
    <span
      className={
        'shrink-0 text-[9px] font-mono uppercase tracking-wider px-1 py-px rounded border ' +
        TYPE_BADGE[type]
      }
    >
      {type}
    </span>
  );
}

function hasChildren(field: ScopeField): boolean {
  if (field.type === 'object' && field.fields && Object.keys(field.fields).length > 0) {
    return true;
  }
  // Array element shape — we expose `item` as a virtual child path so authors can drill in.
  if (field.type === 'array' && field.item) return true;
  return false;
}

function copyToClipboard(text: string): void {
  // Best-effort — clipboard API can reject (insecure context, denied permission). No-op on failure.
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }
}

function FieldNode({
  name,
  field,
  path,
  depth,
  defaultOpen,
  onInsertPath,
}: {
  name: string;
  field: ScopeField;
  path: string;
  depth: number;
  defaultOpen: boolean;
  onInsertPath?: (path: string) => void;
}) {
  const expandable = hasChildren(field);
  const [open, setOpen] = useState(defaultOpen && expandable);

  const handleActivate = () => {
    if (onInsertPath) onInsertPath(path);
    else copyToClipboard(`{{${path}}}`);
  };

  return (
    <div>
      <div
        className="group flex items-start gap-1.5 py-1 px-1 rounded hover:bg-neutral-100 cursor-pointer"
        // Indent via inline padding so deeper nodes stay aligned without a per-depth class explosion.
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={handleActivate}
        title={onInsertPath ? `Click to insert ${path}` : `Click to copy {{${path}}}`}
      >
        {expandable ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            className="shrink-0 w-3 text-neutral-400 hover:text-neutral-700 text-[10px] leading-none mt-1"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="shrink-0 w-3" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <code className="font-mono text-[11px] text-neutral-700 truncate">{name}</code>
            <TypeBadge type={field.type} />
            <span className="ml-auto opacity-0 group-hover:opacity-100 text-[9px] text-neutral-400 shrink-0">
              {onInsertPath ? 'insert' : 'copy'}
            </span>
          </div>
          {field.description && (
            <div className="text-[10px] text-neutral-500 leading-snug mt-0.5">
              {field.description}
            </div>
          )}
        </div>
      </div>
      {open && expandable && (
        <div>
          {field.type === 'object' && field.fields &&
            Object.entries(field.fields).map(([childName, childField]) => (
              <FieldNode
                key={childName}
                name={childName}
                field={childField}
                path={`${path}.${childName}`}
                depth={depth + 1}
                // Only auto-expand the top tier of a section — deeper nodes default closed.
                defaultOpen={false}
                onInsertPath={onInsertPath}
              />
            ))}
          {field.type === 'array' && field.item && (
            <FieldNode
              name="[item]"
              field={field.item}
              path={`${path}.item`}
              depth={depth + 1}
              defaultOpen={false}
              onInsertPath={onInsertPath}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  rootPath,
  fields,
  onInsertPath,
}: {
  title: string;
  rootPath: string;
  fields: Record<string, ScopeField>;
  onInsertPath?: (path: string) => void;
}) {
  return (
    <div>
      <div className="text-[10px] text-neutral-500 tracking-wider mb-1">{title}</div>
      <div>
        {Object.entries(fields).map(([name, field]) => (
          <FieldNode
            key={name}
            name={name}
            field={field}
            path={`${rootPath}.${name}`}
            depth={0}
            // Auto-expand the first level so authors immediately see nested fields without clicking.
            defaultOpen
            onInsertPath={onInsertPath}
          />
        ))}
      </div>
    </div>
  );
}

export function ScopePanel({ scope, onInsertPath }: Props): ReactElement {
  const variableCount = Object.keys(scope.variables).length;
  const outputCount = Object.keys(scope.outputs).length;
  const hasLoop = scope.loop !== undefined;

  if (variableCount === 0 && outputCount === 0 && !hasLoop) {
    return (
      <div className="text-[11px] text-neutral-500 italic">
        Nothing in scope here. Declare workflow variables or set outputVariable on earlier steps.
      </div>
    );
  }

  // Build the loop section as a synthetic record so it renders through the same code path.
  const loopFields: Record<string, ScopeField> | null = scope.loop
    ? { item: scope.loop.item, index: scope.loop.index }
    : null;

  return (
    <div className="space-y-3">
      {variableCount > 0 && (
        <Section
          title="VARIABLES"
          rootPath="variables"
          fields={scope.variables}
          onInsertPath={onInsertPath}
        />
      )}
      {outputCount > 0 && (
        <Section
          title="OUTPUTS"
          rootPath="outputs"
          fields={scope.outputs}
          onInsertPath={onInsertPath}
        />
      )}
      {loopFields && (
        <Section
          title="LOOP"
          rootPath="loop"
          fields={loopFields}
          onInsertPath={onInsertPath}
        />
      )}
    </div>
  );
}
