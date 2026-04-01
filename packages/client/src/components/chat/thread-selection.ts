export function getEffectiveActiveThreadId(
  routeThreadId?: string,
  serverActiveThreadId?: string
): string | null {
  if (routeThreadId) return routeThreadId;
  if (serverActiveThreadId) return serverActiveThreadId;
  return null;
}
