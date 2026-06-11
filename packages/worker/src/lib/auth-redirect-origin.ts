import type { Env } from '../env.js';

function parseOrigin(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

function normalizeHostSuffix(raw?: string): string | undefined {
  const suffix = raw?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!suffix || !suffix.includes('.') || suffix === 'pages.dev') return undefined;
  return suffix;
}

export function resolveAuthRedirectOrigin(env: Env, rawOrigin?: string): string | undefined {
  const origin = parseOrigin(rawOrigin);
  if (!origin) return undefined;

  const configuredFrontendOrigin = parseOrigin(env.FRONTEND_URL);
  if (configuredFrontendOrigin && origin === configuredFrontendOrigin) {
    return origin;
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'https:') return undefined;

  const suffix = normalizeHostSuffix(env.FRONTEND_PREVIEW_ORIGIN_SUFFIX);
  if (!suffix) return undefined;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(`.${suffix}`)) {
    return origin;
  }

  return undefined;
}

export function getDefaultFrontendOrigin(env: Env): string {
  return parseOrigin(env.FRONTEND_URL) ?? 'http://localhost:5173';
}

export function getAuthRedirectOrigin(env: Env, rawOrigin?: string): string {
  return resolveAuthRedirectOrigin(env, rawOrigin) ?? getDefaultFrontendOrigin(env);
}
