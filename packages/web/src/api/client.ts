/**
 * Typed REST client. Routes are documented inline; types come from
 * `@valet/api/wire` so server + web agree on the shape.
 *
 * Auth: in dev mode, the server runs with VALET_LOCAL_AUTH=1 and accepts any
 * (or no) Authorization header. We don't ship one for now; later when real
 * auth lands we'll wire token storage here.
 */
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  GetSessionResponse,
  ListMessagesResponse,
  ListSessionsResponse,
  ListThreadsResponse,
  MeResponse,
  PatchSessionRequest,
  PatchSessionResponse,
  PatchThreadRequest,
  PatchThreadResponse,
  SendPromptRequest,
  SendPromptResponse,
} from "@valet/api/wire";

const BASE = "/api"; // Vite proxies /api → server; same in production.

class ApiError extends Error {
  constructor(public status: number, message: string, public payload?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {}
    throw new ApiError(res.status, `${method} ${path} → ${res.status}`, payload);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // auth
  me: () => request<MeResponse>("GET", "/auth/me"),

  // sessions
  listSessions: () => request<ListSessionsResponse>("GET", "/sessions"),
  getSession: (id: string) => request<GetSessionResponse>("GET", `/sessions/${id}`),
  createSession: (body: CreateSessionRequest) =>
    request<CreateSessionResponse>("POST", "/sessions", body),
  deleteSession: (id: string) => request<{ ok: true }>("DELETE", `/sessions/${id}`),
  patchSession: (id: string, body: PatchSessionRequest) =>
    request<PatchSessionResponse>("PATCH", `/sessions/${id}`, body),

  // threads + messages (session-scoped)
  listThreads: (sessionId: string) =>
    request<ListThreadsResponse>("GET", `/sessions/${sessionId}/threads`),
  createThread: (sessionId: string, body: CreateThreadRequest = {}) =>
    request<CreateThreadResponse>("POST", `/sessions/${sessionId}/threads`, body),
  patchThread: (sessionId: string, threadId: string, body: PatchThreadRequest) =>
    request<PatchThreadResponse>(
      "PATCH",
      `/sessions/${sessionId}/threads/${threadId}`,
      body,
    ),
  listMessages: (
    sessionId: string,
    opts?: { limit?: number; cursor?: string; threadId?: string },
  ) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.threadId) qs.set("threadId", opts.threadId);
    const tail = qs.toString() ? `?${qs}` : "";
    return request<ListMessagesResponse>("GET", `/sessions/${sessionId}/messages${tail}`);
  },
  sendPrompt: (sessionId: string, body: SendPromptRequest) =>
    request<SendPromptResponse>("POST", `/sessions/${sessionId}/messages`, body),
};

export { ApiError };
