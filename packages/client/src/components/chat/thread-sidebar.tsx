import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useThreads, useDismissThread, useReactivateThread, useRenameThread } from '@/api/threads';
import { useQueries } from '@tanstack/react-query';
import { api } from '@/api/client';
import { formatChannelLabel } from '@valet/sdk';
import { getChannelIcon } from '@valet/sdk/ui';
import type { SessionThread } from '@/api/types';
import { cn } from '@/lib/cn';

// ─── Unread Tracking ──────────────────────────────────────────────────────────

function getLastViewed(threadId: string): number {
  try {
    const raw = localStorage.getItem(`thread-last-viewed:${threadId}`);
    return raw ? Number(raw) : 0;
  } catch { return 0; }
}

function setLastViewed(threadId: string) {
  try {
    localStorage.setItem(`thread-last-viewed:${threadId}`, String(Date.now()));
  } catch { /* ignore */ }
}

// ─── Collapse State ───────────────────────────────────────────────────────────

function getSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem('thread-sidebar-collapsed') === 'true';
  } catch { return false; }
}

function setSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem('thread-sidebar-collapsed', String(collapsed));
  } catch { /* ignore */ }
}

// ─── Channel Label Resolution ─────────────────────────────────────────────────

function useResolvedChannelLabels(threads: SessionThread[]): Map<string, string> {
  const resolvable = useMemo(() => {
    const seen = new Set<string>();
    const result: { channelType: string; channelId: string }[] = [];
    for (const t of threads) {
      if (!t.channelType || t.channelType === 'web' || !t.channelId) continue;
      const key = `${t.channelType}:${t.channelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ channelType: t.channelType, channelId: t.channelId });
    }
    return result;
  }, [threads]);

  const results = useQueries({
    queries: resolvable.map((ch) => ({
      queryKey: ['channel-label', ch.channelType, ch.channelId] as const,
      queryFn: () => api.get<{ label: string | null }>(
        `/channels/label?channelType=${encodeURIComponent(ch.channelType)}&channelId=${encodeURIComponent(ch.channelId)}`
      ),
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60,
    })),
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < resolvable.length; i++) {
      const ch = resolvable[i];
      const result = results[i];
      if (result.data?.label) {
        map.set(`${ch.channelType}:${ch.channelId}`, result.data.label);
      }
    }
    return map;
  }, [resolvable, results]);
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

interface ThreadGroup {
  channelKey: string;
  channelType: string;
  channelId: string;
  label: string;
  threads: SessionThread[];
}

function groupThreadsByChannel(
  threads: SessionThread[],
  resolvedLabels: Map<string, string>
): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();

  for (const thread of threads) {
    const ct = thread.channelType || 'web';
    const ci = thread.channelId || 'default';
    const key = `${ct}:${ci}`;

    if (!groups.has(key)) {
      const resolved = resolvedLabels.get(key);
      const label = resolved || formatChannelLabel(ct, ci);
      groups.set(key, { channelKey: key, channelType: ct, channelId: ci, label, threads: [] });
    }
    groups.get(key)!.threads.push(thread);
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.channelType === 'web' && b.channelType !== 'web') return -1;
    if (b.channelType === 'web' && a.channelType !== 'web') return 1;
    return a.label.localeCompare(b.label);
  });
}

// ─── Thread Item ──────────────────────────────────────────────────────────────

function ThreadItem({
  thread,
  isActive,
  onSelect,
  onDismiss,
  isDismissed,
  sessionId,
}: {
  thread: SessionThread;
  isActive: boolean;
  onSelect: () => void;
  onDismiss?: () => void;
  isDismissed?: boolean;
  sessionId: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const savedRef = useRef(false);
  const renameThread = useRenameThread(sessionId);

  const lastViewed = getLastViewed(thread.id);
  const threadLastActive = new Date(thread.lastActiveAt).getTime();
  const hasUnread = !isActive && threadLastActive > lastViewed && thread.messageCount > 0;

  const startEditing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    savedRef.current = false;
    setEditValue(thread.title || thread.firstMessagePreview || '');
    setIsEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [thread.title, thread.firstMessagePreview]);

  const saveTitle = useCallback(() => {
    if (savedRef.current) return;
    savedRef.current = true;
    const trimmed = editValue.trim();
    if (trimmed !== (thread.title || '')) {
      renameThread.mutate({ threadId: thread.id, title: trimmed });
    }
    setIsEditing(false);
  }, [editValue, thread.title, thread.id, renameThread]);

  if (isEditing) {
    return (
      <div className="px-2 py-1">
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveTitle();
            if (e.key === 'Escape') { savedRef.current = true; setIsEditing(false); }
          }}
          onBlur={saveTitle}
          className="w-full rounded border border-violet-300 bg-white px-1 py-0.5 text-[11px] text-neutral-900 outline-none focus:ring-1 focus:ring-violet-400 dark:border-violet-600 dark:bg-neutral-900 dark:text-neutral-100"
          autoFocus
          maxLength={200}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[11px] transition-colors',
        isActive
          ? 'bg-surface-2 text-neutral-900 dark:bg-surface-3 dark:text-neutral-100'
          : 'text-neutral-500 hover:bg-surface-1 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-surface-2 dark:hover:text-neutral-200'
      )}
    >
      <span className="flex-1 truncate">
        {thread.title || thread.firstMessagePreview || 'New thread'}
      </span>
      {hasUnread && !isDismissed && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
      )}
      <span
        role="button"
        tabIndex={-1}
        onClick={startEditing}
        className="shrink-0 rounded p-0.5 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-600 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
        title="Rename"
      >
        <PencilIcon className="h-2.5 w-2.5" />
      </span>
      {onDismiss && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          className="shrink-0 rounded p-0.5 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-600 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
        >
          <XIcon className="h-2.5 w-2.5" />
        </span>
      )}
    </button>
  );
}

// ─── Thread Group Header ──────────────────────────────────────────────────────

function ThreadGroupHeader({ group }: { group: ThreadGroup }) {
  const Icon = getChannelIcon(group.channelType);
  return (
    <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[9px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
      <Icon className="h-2.5 w-2.5" />
      <span className="truncate">{group.label}</span>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

interface ThreadSidebarProps {
  sessionId: string;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
}

export function ThreadSidebar({
  sessionId,
  activeThreadId,
  onSelectThread,
  onNewThread,
}: ThreadSidebarProps) {
  const [collapsed, setCollapsed] = useState(getSidebarCollapsed);
  const [showDismissed, setShowDismissed] = useState(false);

  const { data: threadData } = useThreads(sessionId);
  const dismissThread = useDismissThread(sessionId);
  const reactivateThread = useReactivateThread(sessionId);

  const allThreads = threadData?.threads ?? [];
  const activeThreads = useMemo(() => allThreads.filter((t) => t.status === 'active'), [allThreads]);
  const dismissedThreads = useMemo(() => allThreads.filter((t) => t.status === 'archived'), [allThreads]);

  const resolvedLabels = useResolvedChannelLabels(allThreads);
  const groups = useMemo(() => groupThreadsByChannel(activeThreads, resolvedLabels), [activeThreads, resolvedLabels]);

  useEffect(() => {
    if (activeThreadId) setLastViewed(activeThreadId);
  }, [activeThreadId]);

  const handleDismiss = useCallback(
    (threadId: string) => {
      dismissThread.mutate(threadId);
      if (threadId === activeThreadId) {
        const remaining = activeThreads.filter((t) => t.id !== threadId);
        if (remaining.length > 0) {
          onSelectThread(remaining[0].id);
        }
      }
    },
    [dismissThread, activeThreadId, activeThreads, onSelectThread]
  );

  const handleReactivate = useCallback(
    (threadId: string) => {
      reactivateThread.mutate(threadId);
      onSelectThread(threadId);
    },
    [reactivateThread, onSelectThread]
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      setSidebarCollapsed(next);
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <div className="flex shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="p-2 text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          title="Expand threads"
        >
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-[210px] shrink-0 flex-col border-r border-neutral-200 bg-surface-0 dark:border-neutral-800 dark:bg-surface-0">
      <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2 dark:border-neutral-800/50">
        <span className="text-[11px] font-semibold text-neutral-500 dark:text-neutral-400">
          Threads
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onNewThread}
            className="rounded p-0.5 text-violet-500 transition-colors hover:bg-violet-50 dark:hover:bg-violet-950/30"
            title="New thread"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
            title="Collapse sidebar"
          >
            <ChevronLeftIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1 py-1">
        {groups.map((group) => (
          <div key={group.channelKey}>
            <ThreadGroupHeader group={group} />
            {group.threads.map((thread) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                isActive={thread.id === activeThreadId}
                onSelect={() => onSelectThread(thread.id)}
                onDismiss={() => handleDismiss(thread.id)}
                sessionId={sessionId}
              />
            ))}
          </div>
        ))}
        {activeThreads.length === 0 && (
          <div className="px-2 py-4 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
            No active threads
          </div>
        )}
      </div>

      {dismissedThreads.length > 0 && (
        <div className="border-t border-neutral-100 dark:border-neutral-800/50">
          <button
            type="button"
            onClick={() => setShowDismissed(!showDismissed)}
            className="flex w-full items-center justify-between px-3 py-1.5 text-[10px] text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <span>Dismissed</span>
            <span className="tabular-nums">{dismissedThreads.length}</span>
          </button>
          {showDismissed && (
            <div className="px-1 pb-1">
              {dismissedThreads.map((thread) => (
                <ThreadItem
                  key={thread.id}
                  thread={thread}
                  isActive={false}
                  onSelect={() => handleReactivate(thread.id)}
                  isDismissed
                  sessionId={sessionId}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function XIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 6 6 18" /><path d="m6 6 12 12" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M5 12h14" /><path d="M12 5v14" />
    </svg>
  );
}

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" />
    </svg>
  );
}
