import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import {
  resolveScopePath,
  type Scope,
  type ScopeField,
  type ScopeFieldType,
} from './scope-inferencer';

// ---------- Pure helpers (exported for testing) ----------

export interface TemplateToken {
  type: 'literal' | 'token';
  text: string;
  path?: string;
  start: number;
  end: number;
}

/**
 * Splits `input` into literal text and `{{path}}` tokens. Unclosed `{{` stays
 * inside the surrounding literal — we only mark a token when we see the
 * matching `}}`. This keeps highlighting stable while the user is mid-typing.
 */
export function tokenizeTemplate(input: string): TemplateToken[] {
  const out: TemplateToken[] = [];
  let i = 0;
  let literalStart = 0;
  while (i < input.length) {
    if (input[i] === '{' && input[i + 1] === '{') {
      const close = input.indexOf('}}', i + 2);
      if (close === -1) break; // unclosed — rest is literal
      if (i > literalStart) {
        out.push({
          type: 'literal',
          text: input.slice(literalStart, i),
          start: literalStart,
          end: i,
        });
      }
      const inner = input.slice(i + 2, close);
      out.push({
        type: 'token',
        text: input.slice(i, close + 2),
        path: inner.trim(),
        start: i,
        end: close + 2,
      });
      i = close + 2;
      literalStart = i;
      continue;
    }
    i++;
  }
  if (literalStart < input.length) {
    out.push({
      type: 'literal',
      text: input.slice(literalStart),
      start: literalStart,
      end: input.length,
    });
  }
  return out;
}

/**
 * Finds an in-progress `{{...` whose closing `}}` lies after `cursor` — i.e.
 * the cursor is "inside" an unclosed token. Returns the `{{` position and the
 * prefix typed so far (between `{{` and cursor). A closing `}}` before the
 * cursor or another `{{` between disqualifies the match.
 */
export function findOpenToken(
  input: string,
  cursor: number
): { start: number; prefix: string } | null {
  // Scan backwards for the nearest `{{` and ensure no `}}` sits between it and the cursor.
  let i = cursor - 1;
  while (i >= 1) {
    if (input[i] === '}' && input[i - 1] === '}') return null;
    if (input[i] === '{' && input[i - 1] === '{') {
      const prefix = input.slice(i + 1, cursor);
      // Reject if prefix contains `}` — would be a malformed token, not a completion target.
      if (prefix.includes('}')) return null;
      return { start: i - 1, prefix };
    }
    i--;
  }
  return null;
}

interface FlatCompletion {
  path: string;
  type: ScopeFieldType;
  description?: string;
}

/**
 * Walks a ScopeField tree producing every reachable dotted path, capped to
 * avoid runaway recursion. Object fields produce both the parent path (for
 * `{{x}}`) and child paths.
 */
function walkField(
  prefix: string,
  field: ScopeField,
  out: FlatCompletion[],
  depth: number
): void {
  if (depth > 6) return;
  const entry: FlatCompletion = { path: prefix, type: field.type };
  if (field.description !== undefined) entry.description = field.description;
  out.push(entry);
  if (field.type === 'object' && field.fields) {
    for (const [k, child] of Object.entries(field.fields)) {
      walkField(`${prefix}.${k}`, child, out, depth + 1);
    }
  }
  if (field.type === 'array' && field.item) {
    // Array element exposed as `.item` mirrors how users would index in a loop body.
    walkField(`${prefix}.item`, field.item, out, depth + 1);
  }
}

function flattenScope(scope: Scope): FlatCompletion[] {
  const out: FlatCompletion[] = [];
  for (const [name, field] of Object.entries(scope.variables)) {
    walkField(`variables.${name}`, field, out, 0);
  }
  for (const [name, field] of Object.entries(scope.outputs)) {
    walkField(`outputs.${name}`, field, out, 0);
  }
  if (scope.loop) {
    walkField('loop.item', scope.loop.item, out, 0);
    walkField('loop.index', scope.loop.index, out, 0);
  }
  return out;
}

// ---------- Component ----------

interface TemplatedInputProps {
  value: string;
  onChange: (next: string) => void;
  scope: Scope;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  mono?: boolean;
}

// Shared classes for the textarea/input and the overlay so they wrap identically.
// Border + bg + focus styling lives here; overlay strips border via `border-transparent` so only the textarea draws it.
const SHARED_TEXT_CLASSES =
  'w-full rounded-md border border-border bg-surface-0 dark:bg-surface-2 px-2 py-1 text-sm leading-5 whitespace-pre-wrap break-words focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition';

export function TemplatedInput(props: TemplatedInputProps): JSX.Element {
  const {
    value,
    onChange,
    scope,
    placeholder,
    multiline = false,
    rows = 3,
    mono = false,
  } = props;

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const completions = useMemo(() => flattenScope(scope), [scope]);

  const tokens = useMemo(() => tokenizeTemplate(value), [value]);

  const open = useMemo(() => findOpenToken(value, cursor), [value, cursor]);

  const filtered = useMemo(() => {
    if (!open) return [];
    const q = open.prefix.trim().toLowerCase();
    const matches = q
      ? completions.filter((c) => c.path.toLowerCase().includes(q))
      : completions;
    return matches.slice(0, 12);
  }, [open, completions]);

  // Keep dropdown state in sync with whether we have a viable open token + matches.
  useEffect(() => {
    if (open && filtered.length > 0) {
      setMenuOpen(true);
      setHighlight((h) => (h >= filtered.length ? 0 : h));
    } else {
      setMenuOpen(false);
    }
  }, [open, filtered.length]);

  // Sync overlay scroll to textarea scroll so highlight stays aligned.
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current ?? inputRef.current;
    const overlay = overlayRef.current;
    if (!ta || !overlay) return;
    overlay.scrollTop = ta.scrollTop;
    overlay.scrollLeft = ta.scrollLeft;
  }, []);

  useLayoutEffect(() => {
    syncScroll();
  }, [value, syncScroll]);

  const handleSelectionChange = useCallback(() => {
    const el = textareaRef.current ?? inputRef.current;
    if (!el) return;
    setCursor(el.selectionStart ?? 0);
  }, []);

  const insertCompletion = useCallback(
    (completion: FlatCompletion) => {
      if (!open) return;
      const el = textareaRef.current ?? inputRef.current;
      if (!el) return;
      const before = value.slice(0, open.start);
      const after = value.slice(cursor);
      const inserted = `{{${completion.path}}}`;
      const next = before + inserted + after;
      const newCursor = before.length + inserted.length;
      onChange(next);
      setMenuOpen(false);
      // Restore focus + cursor after React commits the new value.
      requestAnimationFrame(() => {
        const focusEl = textareaRef.current ?? inputRef.current;
        if (!focusEl) return;
        focusEl.focus();
        focusEl.setSelectionRange(newCursor, newCursor);
        setCursor(newCursor);
      });
    },
    [open, value, cursor, onChange]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (!menuOpen || filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = filtered[highlight];
        if (pick) insertCompletion(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuOpen(false);
      }
    },
    [menuOpen, filtered, highlight, insertCompletion]
  );

  const handleRowClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>, completion: FlatCompletion) => {
      // Prevent the textarea from losing focus before we re-focus it in insertCompletion.
      e.preventDefault();
      insertCompletion(completion);
    },
    [insertCompletion]
  );

  const fontClass = mono ? 'font-mono' : '';

  // Overlay sits behind the textarea and holds the visible bg + text. The textarea on top
  // is transparent for both bg and text so only the caret/selection show through.
  // Border lives on the textarea so the focus ring renders correctly when the user is editing.
  const overlayClasses =
    SHARED_TEXT_CLASSES +
    ' ' +
    fontClass +
    ' absolute inset-0 pointer-events-none overflow-hidden text-foreground border-transparent';

  const fieldClasses =
    SHARED_TEXT_CLASSES +
    ' ' +
    fontClass +
    ' relative !bg-transparent text-transparent caret-foreground';

  return (
    <div className="relative">
      <div className="relative">
        <div ref={overlayRef} className={overlayClasses} aria-hidden="true">
          {renderOverlay(tokens, scope)}
          {/* Trailing newline so overlay matches textarea wrap when value ends with \n. */}
          {value.endsWith('\n') ? '\n ' : ''}
        </div>
        {multiline ? (
          <textarea
            ref={textareaRef}
            value={value}
            placeholder={placeholder}
            rows={rows}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={handleKeyDown}
            onKeyUp={handleSelectionChange}
            onClick={handleSelectionChange}
            onSelect={handleSelectionChange}
            onFocus={handleSelectionChange}
            className={fieldClasses + ' resize-y'}
            style={{ position: 'relative', zIndex: 1 }}
          />
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={handleKeyDown}
            onKeyUp={handleSelectionChange}
            onClick={handleSelectionChange}
            onSelect={handleSelectionChange}
            onFocus={handleSelectionChange}
            className={fieldClasses}
            style={{ position: 'relative', zIndex: 1 }}
          />
        )}
      </div>
      {menuOpen && filtered.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-surface-1 border border-border rounded-md shadow-panel py-1 max-h-72 overflow-y-auto">
          {filtered.map((c, idx) => (
            <button
              key={c.path}
              type="button"
              onMouseDown={(e) => handleRowClick(e, c)}
              onMouseEnter={() => setHighlight(idx)}
              className={
                'w-full text-left px-2.5 py-1.5 text-xs cursor-pointer flex items-center gap-2 ' +
                (idx === highlight ? 'bg-accent/10 text-foreground' : 'text-foreground hover:bg-surface-2')
              }
            >
              <code className="font-mono truncate">{c.path}</code>
              <span className="text-[10px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400 bg-surface-2 rounded px-1 py-0.5 shrink-0">
                {c.type}
              </span>
              {c.description && (
                <span className="text-neutral-500 dark:text-neutral-400 truncate">{c.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function renderOverlay(tokens: TemplateToken[], scope: Scope): JSX.Element[] {
  return tokens.map((tok, i) => {
    if (tok.type === 'literal') {
      return <span key={i}>{tok.text}</span>;
    }
    const path = tok.path ?? '';
    const valid = path !== '' && resolveScopePath(scope, path) !== null;
    if (valid) {
      return (
        <span
          key={i}
          className="bg-accent/15 text-accent rounded px-0.5"
        >
          {tok.text}
        </span>
      );
    }
    return (
      <span
        key={i}
        className="bg-red-500/10 text-red-500 dark:text-red-400 underline decoration-wavy decoration-red-500 rounded px-0.5"
        title={`Unresolved path: ${path}`}
      >
        {tok.text}
      </span>
    );
  });
}
