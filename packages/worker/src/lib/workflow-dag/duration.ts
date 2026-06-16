/**
 * Parse a compact duration string like "5s", "10m", "2h", "1d" into
 * milliseconds. Returns null on unparseable input.
 *
 * The compact form is what authors write in `wait.duration`,
 * `approval.timeout`, etc. Cloudflare's WorkflowSleepDuration type wants
 * either a number of milliseconds OR a verbose form like "5 seconds" —
 * we resolve to the number path at executor dispatch time.
 */
export function parseDurationMs(s: string): number | null {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(s.trim());
  if (!match) return null;
  const n = Number(match[1]);
  switch (match[2]) {
    case 'ms': return n;
    case 's':  return n * 1000;
    case 'm':  return n * 60 * 1000;
    case 'h':  return n * 60 * 60 * 1000;
    case 'd':  return n * 24 * 60 * 60 * 1000;
  }
  return null;
}
