import { useAuthStore } from '@/stores/auth';
import { router } from '@/app';

// In production, use the worker URL. In development, proxy through Vite.
const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * Derive the WebSocket base URL from the API base.
 * In dev: /api → ws://localhost:8787/api (via Vite proxy, resolved from window.location.origin)
 * In prod: https://worker.dev/api → wss://worker.dev/api
 */
export function getWebSocketUrl(path: string): string {
  if (API_BASE.startsWith('http')) {
    // Absolute URL — replace protocol and append path
    const url = new URL(path, API_BASE.replace(/\/api$/, ''));
    url.protocol = url.protocol.replace('http', 'ws');
    return url.toString();
  }
  // Relative URL (dev) — resolve against current origin
  const url = new URL(path, window.location.origin);
  url.protocol = url.protocol.replace('http', 'ws');
  return url.toString();
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body' | 'headers'> {
  body?: unknown;
  headers?: Record<string, string>;
}

export async function apiClient<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { body, headers: customHeaders, ...rest } = options;

  const token = useAuthStore.getState().token;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...rest,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let errorData: { error?: string; code?: string; details?: unknown } = {};
    try {
      errorData = await response.json();
    } catch {
      // Response may not be JSON
    }

    if (response.status === 401) {
      useAuthStore.getState().clearAuth();
      router.navigate({ to: '/login' });
    }

    throw new ApiError(
      errorData.error || response.statusText,
      response.status,
      errorData.code,
      errorData.details
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const api = {
  get: <T>(endpoint: string, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'GET' }),

  post: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'POST', body }),

  put: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'PUT', body }),

  patch: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'PATCH', body }),

  delete: <T>(endpoint: string, options?: RequestOptions) =>
    apiClient<T>(endpoint, { ...options, method: 'DELETE' }),

  /**
   * Lower-level fetch wrapper for callers that need the raw Response —
   * streaming endpoints, file uploads, or anything that doesn't return
   * JSON. Adds auth + base URL, doesn't parse the body.
   */
  fetch: (endpoint: string, init?: RequestInit): Promise<Response> => {
    const token = useAuthStore.getState().token;
    const headers = new Headers(init?.headers);
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(`${API_BASE}${endpoint}`, { ...init, headers });
  },
};
