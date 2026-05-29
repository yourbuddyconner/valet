export function getEffectiveActiveThreadId(
  routeThreadId?: string,
  serverActiveThreadId?: string
): string | null {
  if (routeThreadId) return routeThreadId;
  if (serverActiveThreadId) return serverActiveThreadId;
  return null;
}

export interface ThreadScopedChildSessionEvent {
  threadId?: string;
}

export function filterChildSessionEventsForThread<T extends ThreadScopedChildSessionEvent>(
  events: T[],
  activeThreadId: string | null
): T[] {
  if (!activeThreadId) return events;
  return events.filter((event) => event.threadId === activeThreadId);
}
