/**
 * Engine-level errors. Provider/adapter implementations throw these so
 * callers can branch on `instanceof` checks without sniffing message text.
 */

export class NotFoundError extends Error {
  constructor(
    public readonly resource: string,
    public readonly key: string | Record<string, string>,
  ) {
    super(`${resource} not found: ${formatKey(key)}`);
    this.name = "NotFoundError";
  }
}

function formatKey(key: string | Record<string, string>): string {
  if (typeof key === "string") return key;
  return Object.entries(key)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}
