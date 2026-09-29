import type { ThreadSummary } from "@valet/api/wire";

export function isAppAssistantThread(thread: Pick<ThreadSummary, "key">): boolean {
  return Boolean(thread.key?.startsWith("app-assistant:") || thread.key?.startsWith("workflow:"));
}

/** The implicit thread is always the newest created thread, regardless of sidebar sort. */
export function defaultThreadId(threads: ThreadSummary[]): string | undefined {
  return threads.filter((thread) => !isAppAssistantThread(thread)).reduce<ThreadSummary | undefined>(
    (newest, thread) => !newest || thread.createdAt > newest.createdAt ? thread : newest,
    undefined,
  )?.id;
}
