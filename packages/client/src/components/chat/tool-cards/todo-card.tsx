import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { ChecklistIcon, ListIcon } from './icons';
import { cn } from '@/lib/cn';
import type { ToolCallData } from './types';

interface TodoItem {
  id?: string;
  content?: string;
  status?: string;
  priority?: string;
}

export function TodoWriteCard({ tool }: { tool: ToolCallData }) {
  const todos = extractTodos(tool.args, tool.result);
  const count = todos.length;

  return (
    <ToolCardShell
      icon={<ChecklistIcon className="h-3.5 w-3.5" />}
      label="todowrite"
      status={tool.status}
      tool={tool}
      summary={
        <span className="text-neutral-500 dark:text-neutral-400">
          {count} {count === 1 ? 'task' : 'tasks'}
        </span>
      }
    >
      {todos.length > 0 && (
        <ToolCardSection>
          <TodoList todos={todos} />
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

export function TodoReadCard({ tool }: { tool: ToolCallData }) {
  const todos = extractTodos(tool.result, tool.args);
  const count = todos.length;

  return (
    <ToolCardShell
      icon={<ListIcon className="h-3.5 w-3.5" />}
      label="todoread"
      status={tool.status}
      tool={tool}
      summary={
        <span className="text-neutral-500 dark:text-neutral-400">
          {count} {count === 1 ? 'task' : 'tasks'}
        </span>
      }
    >
      {todos.length > 0 && (
        <ToolCardSection>
          <TodoList todos={todos} />
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="overflow-auto" style={{ maxHeight: '280px' }}>
      <div className="space-y-0.5">
        {todos.map((todo, i) => (
          <TodoRow key={todo.id ?? i} todo={todo} />
        ))}
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: string }> = {
  completed: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/20',
    text: 'text-emerald-700 dark:text-emerald-400',
    icon: 'text-emerald-500',
  },
  'in-progress': {
    bg: 'bg-accent/[0.06] dark:bg-accent/[0.06]',
    text: 'text-accent dark:text-accent',
    icon: 'text-accent',
  },
  pending: {
    bg: 'bg-neutral-50 dark:bg-neutral-800/30',
    text: 'text-neutral-600 dark:text-neutral-400',
    icon: 'text-neutral-400 dark:text-neutral-500',
  },
  todo: {
    bg: 'bg-neutral-50 dark:bg-neutral-800/30',
    text: 'text-neutral-600 dark:text-neutral-400',
    icon: 'text-neutral-400 dark:text-neutral-500',
  },
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  normal: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
  low: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500',
};

function TodoRow({ todo }: { todo: TodoItem }) {
  const status = todo.status ?? 'pending';
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.pending;

  return (
    <div className={cn('flex items-start gap-2 rounded px-2 py-1.5', style.bg)}>
      <span className={cn('mt-0.5 shrink-0', style.icon)}>
        {status === 'completed' ? (
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <polyline points="5 8 7 10 11 6" />
          </svg>
        ) : status === 'in-progress' ? (
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <line x1="5.5" y1="8" x2="10.5" y2="8" />
          </svg>
        ) : (
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="12" height="12" rx="2" />
          </svg>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <span className={cn('font-mono text-[11px] leading-snug', style.text)}>
          {todo.content ?? '(no content)'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {todo.priority && todo.priority !== 'normal' && (
          <span className={cn(
            'rounded px-1 py-px font-mono text-[9px] font-medium',
            PRIORITY_COLORS[todo.priority] ?? PRIORITY_COLORS.normal,
          )}>
            {todo.priority}
          </span>
        )}
        {todo.id && (
          <span className="font-mono text-[9px] tabular-nums text-neutral-400 dark:text-neutral-600">
            #{todo.id}
          </span>
        )}
      </div>
    </div>
  );
}

/** Extract todo items from various formats */
function extractTodos(primary: unknown, fallback: unknown): TodoItem[] {
  for (const source of [primary, fallback]) {
    if (!source) continue;

    // Direct array
    if (Array.isArray(source)) {
      return source.filter((x: unknown): x is TodoItem => !!x && typeof x === 'object');
    }

    // Object with todos array
    if (typeof source === 'object') {
      const obj = source as Record<string, unknown>;
      if (Array.isArray(obj.todos)) {
        return obj.todos.filter((x: unknown): x is TodoItem => !!x && typeof x === 'object');
      }
    }

    // JSON string
    if (typeof source === 'string') {
      try {
        const parsed = JSON.parse(source);
        if (Array.isArray(parsed)) {
          return parsed.filter((x: unknown): x is TodoItem => !!x && typeof x === 'object');
        }
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.todos)) {
          return parsed.todos.filter((x: unknown): x is TodoItem => !!x && typeof x === 'object');
        }
      } catch {
        // Not JSON
      }
    }
  }
  return [];
}
