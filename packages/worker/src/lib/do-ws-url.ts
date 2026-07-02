import type { Env } from '../env.js';

type DoWebSocketEnv = Pick<Env, 'API_PUBLIC_URL'>;

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

function isNetworkUrl(url: URL | null): url is URL {
  return url !== null && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function buildDoWebSocketUrl(args: {
  env: DoWebSocketEnv;
  sessionId: string;
  requestUrl?: string;
  requestHost?: string;
}): string {
  const { env, sessionId, requestUrl } = args;

  const explicitApiUrl = parseMaybeUrl(env.API_PUBLIC_URL);
  if (explicitApiUrl) {
    const explicitProtocol = explicitApiUrl.protocol === 'http:' ? 'ws' : 'wss';
    return `${explicitProtocol}://${explicitApiUrl.host}/api/sessions/${sessionId}/ws`;
  }

  const parsedRequestUrl = parseMaybeUrl(requestUrl);
  const requestParsed = isNetworkUrl(parsedRequestUrl) ? parsedRequestUrl : null;
  if (requestParsed && isLocalHost(requestParsed.hostname)) {
    const requestProtocol = requestParsed?.protocol === 'http:' || requestParsed?.protocol === 'ws:' ? 'ws' : 'wss';
    return `${requestProtocol}://${requestParsed.host}/api/sessions/${sessionId}/ws`;
  }

  throw new Error('API_PUBLIC_URL is required to construct sandbox runner WebSocket URLs outside local development');
}
