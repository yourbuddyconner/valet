import * as React from 'react';
import { NODE_DOCS, type DagNodeType, type NodeDocs } from '@valet/shared';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { cn } from '@/lib/cn';
import { MarkdownContent } from '@/components/chat/markdown/markdown-content';

interface NodeDocsDrawerProps {
  open: boolean;
  onClose: () => void;
  /**
   * Optional: focus on a particular node type when opened (e.g. the
   * currently-selected node's type). The drawer scrolls to it.
   */
  focusType?: DagNodeType;
}

// Display order — mirrors the palette grouping so the drawer reads in the
// same shape as the picker.
const NODE_ORDER: DagNodeType[] = [
  'trigger',
  'llm',
  'tool',
  'set',
  'if',
  'foreach',
  'approval',
  'wait',
  'orchestrator',
  'session',
  'stop',
];

export function NodeDocsDrawer({ open, onClose, focusType }: NodeDocsDrawerProps) {
  const [query, setQuery] = React.useState('');
  const sectionRefs = React.useRef<Partial<Record<DagNodeType, HTMLElement | null>>>({});

  // Scroll the focused type into view when the drawer opens. rAF defers
  // the call until the section has been laid out.
  React.useEffect(() => {
    if (!open || !focusType) return;
    const frame = requestAnimationFrame(() => {
      sectionRefs.current[focusType]?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, focusType]);

  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const trimmed = query.trim().toLowerCase();
  const filteredTypes = trimmed
    ? NODE_ORDER.filter((type) => matchesQuery(type, NODE_DOCS[type], trimmed))
    : NODE_ORDER;

  return (
    <aside
      className="absolute bottom-3 left-3 top-3 z-10 flex w-[440px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white/95 shadow-2xl backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95"
      role="dialog"
      aria-label="Node reference"
    >
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Node reference</div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
            What each node does and when to reach for it.
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 px-2"
          onClick={onClose}
          aria-label="Close"
        >
          Close
        </Button>
      </header>
      <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search node types, fields…"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {filteredTypes.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
            Nothing matches "{query}".
          </p>
        ) : (
          filteredTypes.map((type) => (
            <NodeDocsSection
              key={type}
              ref={(el) => { sectionRefs.current[type] = el; }}
              type={type}
              docs={NODE_DOCS[type]}
              highlighted={type === focusType}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function matchesQuery(type: DagNodeType, docs: NodeDocs, q: string): boolean {
  if (type.toLowerCase().includes(q)) return true;
  if (docs.label.toLowerCase().includes(q)) return true;
  if (docs.description.toLowerCase().includes(q)) return true;
  if (docs.longDescription.toLowerCase().includes(q)) return true;
  if (docs.fields) {
    for (const [field, help] of Object.entries(docs.fields)) {
      if (field.toLowerCase().includes(q)) return true;
      if (help?.help.toLowerCase().includes(q)) return true;
    }
  }
  if (docs.gotchas?.some((g) => g.toLowerCase().includes(q))) return true;
  return false;
}

interface NodeDocsSectionProps {
  type: DagNodeType;
  docs: NodeDocs;
  highlighted: boolean;
}

const NodeDocsSection = React.forwardRef<HTMLElement, NodeDocsSectionProps>(
  ({ type, docs, highlighted }, ref) => {
    const fieldEntries = docs.fields ? Object.entries(docs.fields) : [];
    return (
      <section
        ref={ref}
        className={cn(
          'rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900',
          highlighted && 'ring-2 ring-accent/40 dark:ring-red-400/40',
        )}
      >
        <header className="mb-2 flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {docs.label} <span className="text-neutral-400 dark:text-neutral-500">node</span>
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{docs.description}</p>
          </div>
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
            {type}
          </code>
        </header>

        {docs.gotchas && docs.gotchas.length > 0 && (
          <div className="mb-2 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            {docs.gotchas.map((g, i) => (
              <p key={i}>⚠ {g}</p>
            ))}
          </div>
        )}

        <div className="prose prose-sm max-w-none text-xs text-neutral-700 dark:prose-invert dark:text-neutral-300">
          <MarkdownContent content={docs.longDescription} />
        </div>

        {fieldEntries.length > 0 && (
          <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Fields
            </div>
            <dl className="space-y-2 text-xs">
              {fieldEntries.map(([field, doc]) => (
                <div key={field}>
                  <dt className="font-mono text-[11px] text-neutral-900 dark:text-neutral-100">{field}</dt>
                  <dd className="mt-0.5 text-neutral-600 dark:text-neutral-400">{doc?.help}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </section>
    );
  },
);
NodeDocsSection.displayName = 'NodeDocsSection';
