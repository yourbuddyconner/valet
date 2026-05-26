import { ValidationError } from '@valet/shared';
import { validateOutboundUrl, type OutboundUrlPolicyOptions } from './outbound-url-policy.js';

export type SafeFetchMode = 'mcp' | 'oauth-token' | 'discovery';

export interface SafeFetchOutboundOptions extends OutboundUrlPolicyOptions {
  mode?: SafeFetchMode;
  fetch?: typeof fetch;
  maxRedirects?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;

export function createSafeFetchOutbound(defaultOptions: SafeFetchOutboundOptions = {}): typeof fetch {
  return (input, init) => safeFetchOutbound(input, init, defaultOptions);
}

export async function safeFetchOutbound(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: SafeFetchOutboundOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const mode = options.mode ?? 'mcp';
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let currentUrl = await validateOutboundUrl(getInputUrl(input), options);
  let currentInput: RequestInfo | URL = currentUrl.href;
  let currentInit = mergeRequestInit(input, init);

  for (let redirects = 0; ; redirects++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = composeAbortSignal(currentInit.signal, controller);
    let response: Response;
    try {
      response = await fetchImpl(currentInput, {
        ...currentInit,
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }

    if (!isRedirect(response.status)) {
      return responseWithTimedBody(response, timeout);
    }

    clearTimeout(timeout);

    const location = response.headers.get('location');
    if (!location) {
      throw new ValidationError('Outbound connector request returned a redirect without a Location header.');
    }
    if (mode !== 'discovery') {
      throw new ValidationError('Outbound connector requests do not follow redirects.');
    }
    if (redirects >= maxRedirects) {
      throw new ValidationError('Outbound connector discovery exceeded the redirect limit.');
    }

    const nextUrl = await validateOutboundUrl(new URL(location, currentUrl), options);
    const sameOrigin = nextUrl.origin === currentUrl.origin;
    currentInit = {
      ...currentInit,
      headers: sameOrigin ? currentInit.headers : stripCrossOriginHeaders(currentInit.headers),
    };
    currentUrl = nextUrl;
    currentInput = nextUrl.href;
  }
}

function getInputUrl(input: RequestInfo | URL): string | URL {
  if (input instanceof Request) return input.url;
  return input;
}

function mergeRequestInit(input: RequestInfo | URL, init: RequestInit): RequestInit {
  if (!(input instanceof Request)) return { ...init };
  return {
    method: init.method ?? input.method,
    headers: init.headers ?? input.headers,
    body: init.body ?? input.body,
    ...init,
  };
}

function composeAbortSignal(existing: AbortSignal | null | undefined, controller: AbortController): AbortSignal {
  if (!existing) return controller.signal;
  if (existing.aborted) {
    controller.abort();
    return controller.signal;
  }
  existing.addEventListener('abort', () => controller.abort(), { once: true });
  return controller.signal;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function responseWithTimedBody(response: Response, timeout: ReturnType<typeof setTimeout>): Response {
  if (!response.body) {
    clearTimeout(timeout);
    return response;
  }

  return new Response(wrapTimedBody(response.body, timeout), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function wrapTimedBody(body: ReadableStream<Uint8Array>, timeout: ReturnType<typeof setTimeout>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cleanedUp = false;
  const cleanup = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      clearTimeout(timeout);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        cleanup();
        controller.error(err);
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

function stripCrossOriginHeaders(headers: HeadersInit | undefined): Headers {
  const stripped = new Headers();
  const original = new Headers(headers);
  for (const [name, value] of original) {
    const lower = name.toLowerCase();
    if (lower === 'accept' || lower === 'content-type') {
      stripped.set(name, value);
    }
  }
  return stripped;
}
