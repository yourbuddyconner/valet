import { useMemo, useState } from "react";
import { z } from "zod";
import { safeLocalStorage } from "./safe-storage";

const schema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), collapsed: z.boolean() })),
  pinned: z.array(z.string()).default([]),
  assignments: z.record(z.string(), z.string()),
  grouped: z.boolean(),
  collapsed: z.boolean(),
});
export type ThreadProjects = z.infer<typeof schema>;

function read(key: string): ThreadProjects {
  try {
    const parsed = schema.safeParse(JSON.parse(safeLocalStorage().getItem(key) ?? "null"));
    if (parsed.success) return parsed.data;
  } catch { /* Invalid or unavailable browser preferences. */ }
  return { pinned: [], projects: [], assignments: {}, grouped: true, collapsed: false };
}

/** Personal display preferences, scoped to viewer and workspace runtime. */
export function useThreadProjects(viewerId: string, sessionId: string) {
  const key = `valet:thread-projects:${encodeURIComponent(viewerId)}:${encodeURIComponent(sessionId)}`;
  const initial = useMemo(() => read(key), [key]);
  const [saved, setSaved] = useState<{ key: string; value: ThreadProjects }>();
  const value = saved?.key === key ? saved.value : initial;
  function update(change: (previous: ThreadProjects) => ThreadProjects) {
    const next = change(read(key));
    safeLocalStorage().setItem(key, JSON.stringify(next));
    setSaved({ key, value: next });
  }
  return { value, update };
}
