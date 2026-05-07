/**
 * Constants and utility helpers shared across db service modules.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

export const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 0,
  collaborator: 1,
  owner: 2,
};

export const ACTIVE_SESSION_STATUSES = ['initializing', 'running', 'idle', 'restoring'];
export const DEFAULT_MAX_ACTIVE_SESSIONS = 10;
export const MEMORY_CAP = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────

export function generateShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeNotificationEventType(eventType?: string | null): string {
  const trimmed = eventType?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : '*';
}
