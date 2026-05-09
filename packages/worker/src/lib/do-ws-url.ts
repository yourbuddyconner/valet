import type { Env } from '../env.js';

const PAGES_DEV_SUFFIX = '.pages.dev';

function parseMaybeUrl(raw?: string): URL | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  try {
    return new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return null;
  }
}

function isPagesHost(host: string): boolean {
  return host.endsWith(PAGES_DEV_SUFFIX);
}

function deriveApiHostFromFrontend(frontendHost: string, workerName?: string): string | null {
  if (frontendHost.startsWith('app.')) {
    return frontendHost.replace(/^app\./, 'api.');
  }

  // NOTE: pages.dev URLs (e.g. foo-client.pages.dev) don't include the account
  // subdomain that workers.dev requires (e.g. foo.valet-turnkey.workers.dev).
  // Set API_PUBLIC_URL as a worker secret to avoid hitting this fallback.
  if (isPagesHost(frontendHost)) {
    const pagesLabel = frontendHost.slice(0, -PAGES_DEV_SUFFIX.length);
    if (pagesLabel.endsWith('-client')) {
      return `${pagesLabel.slice(0, -'-client'.length)}.workers.dev`;
    }
    const trimmedWorkerName = workerName?.trim();
    if (trimmedWorkerName) {
      return `${trimmedWorkerName}.workers.dev`;
    }
  }

  return null;
}

export function buildDoWebSocketUrl(args: {
  env: Env;
  sessionId: string;
  requestUrl?: string;
  requestHost?: string;
}): string {
  const { env, sessionId, requestUrl, requestHost } = args;

  const explicitApiUrl = parseMaybeUrl(env.API_PUBLIC_URL);
  if (explicitApiUrl) {
    const explicitProtocol = explicitApiUrl.protocol === 'http:' ? 'ws' : 'wss';
    return `${explicitProtocol}://${explicitApiUrl.host}/api/sessions/${sessionId}/ws`;
  }

  const requestParsed = parseMaybeUrl(requestUrl);
  const requestHostValue = requestParsed?.host || requestHost?.trim() || '';
  if (requestHostValue && !isPagesHost(requestHostValue)) {
    const requestProtocol = requestParsed?.protocol === 'http:' ? 'ws' : 'wss';
    return `${requestProtocol}://${requestHostValue}/api/sessions/${sessionId}/ws`;
  }

  const frontendParsed = parseMaybeUrl(env.FRONTEND_URL);
  const derivedHost = frontendParsed
    ? deriveApiHostFromFrontend(frontendParsed.host, env.WORKER_NAME)
    : null;
  if (derivedHost) {
    return `wss://${derivedHost}/api/sessions/${sessionId}/ws`;
  }

  const fallbackHost = requestHostValue || frontendParsed?.host || 'localhost:8787';
  const fallbackProtocol = requestParsed?.protocol === 'http:' ? 'ws' : 'wss';
  return `${fallbackProtocol}://${fallbackHost}/api/sessions/${sessionId}/ws`;
}
