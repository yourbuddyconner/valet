/**
 * Auth gateway proxy on port 9000 inside the sandbox.
 *
 * Routes:
 *   /vscode/*  → localhost:8765 (code-server)
 *   /vnc/*     → localhost:6080 (noVNC via websockify)
 *   /ttyd/*    → localhost:7681 (TTYD web terminal)
 *   /health    → 200 OK (no auth)
 *
 * Authentication:
 *   - Initial requests use JWT token via ?token= query param or Authorization header
 *   - After JWT validation, a session cookie is set for subsequent requests
 *   - This allows code-server/ttyd/novnc to load assets without token in URL
 */

import { Hono } from "hono";

const app = new Hono();

type TunnelProtocol = "http" | "ws" | "auto";

interface TunnelEntry {
  name: string;
  port: number;
  protocol: TunnelProtocol;
}

interface TunnelDescriptor extends TunnelEntry {
  path: string;
}

const TUNNEL_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const tunnelRegistry = new Map<string, TunnelEntry>();

// Session cookie name
const SESSION_COOKIE = "gateway_session";
// Cookie max age (15 minutes, matching JWT expiry)
const COOKIE_MAX_AGE = 15 * 60;

// In-memory session store (valid for this sandbox instance)
const validSessions = new Map<string, { userId: string; sessionId: string; expiresAt: number }>();

// ─── JWT Validation ──────────────────────────────────────────────────────

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function verifyJWT(
  token: string,
  secret: string,
): Promise<{ sub: string; sid: string; exp: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signature = base64UrlDecode(signatureB64);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature as ArrayBufferView<ArrayBuffer>,
    encoder.encode(signingInput),
  );
  if (!valid) return null;

  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadB64)),
  ) as { sub: string; sid: string; exp: number };

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

// ─── Session Management ──────────────────────────────────────────────────

function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function createSession(userId: string, sessionId: string): string {
  const token = generateSessionToken();
  const expiresAt = Date.now() + COOKIE_MAX_AGE * 1000;
  validSessions.set(token, { userId, sessionId, expiresAt });
  return token;
}

function validateSession(token: string): boolean {
  const session = validSessions.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    validSessions.delete(token);
    return false;
  }
  return true;
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

// ─── Middleware ───────────────────────────────────────────────────────────

function jwtSecret(): string {
  return process.env.JWT_SECRET || "";
}

// Track if we need to set a session cookie on this request
let pendingSessionCookie: string | null = null;

async function authMiddleware(c: any, next: () => Promise<void>) {
  pendingSessionCookie = null;

  // Check for existing session cookie first
  const cookies = parseCookies(c.req.header("Cookie"));
  const sessionToken = cookies[SESSION_COOKIE];

  if (sessionToken && validateSession(sessionToken)) {
    // Valid session cookie - proceed without setting new cookie
    await next();
    return;
  }

  // No valid session cookie - need JWT token
  const tokenParam = c.req.query("token");
  const authHeader = c.req.header("Authorization");
  const token = tokenParam || authHeader?.replace("Bearer ", "");

  if (!token) {
    return new Response(JSON.stringify({ error: "Missing token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const payload = await verifyJWT(token, jwtSecret());
  if (!payload) {
    return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Create a session for subsequent requests
  pendingSessionCookie = createSession(payload.sub, payload.sid);

  await next();
}

// ─── Helper: Strip compression headers for clean proxying ────────────────

function createProxyHeaders(rawHeaders: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of rawHeaders.entries()) {
    // Skip compression-related headers to avoid encoding issues through tunnels
    // Also skip hop-by-hop headers that shouldn't be forwarded
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "accept-encoding" ||
      lowerKey === "content-encoding" ||
      lowerKey === "transfer-encoding" ||
      lowerKey === "connection" ||
      lowerKey === "keep-alive" ||
      lowerKey === "host"
    ) {
      continue;
    }
    headers.set(key, value);
  }
  // Request uncompressed content from backend
  headers.set("Accept-Encoding", "identity");
  return headers;
}

// ─── Helper: Add session cookie to response ──────────────────────────────

function addSessionCookie(response: Response): Response {
  if (!pendingSessionCookie) return response;

  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${pendingSessionCookie}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=None; Secure`
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", service: "gateway" }));

// OpenCode proxy — no auth (accessed server-to-server from the DO, which has already authenticated)
app.all("/opencode/*", async (c) => {
  const path = c.req.path.replace(/^\/opencode/, "") || "/";
  const url = new URL(c.req.url);
  const searchParams = new URLSearchParams(url.search);
  const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const target = `http://127.0.0.1:4096${path}${cleanSearch}`;

  try {
    const res = await fetch(target, {
      method: c.req.method,
      headers: createProxyHeaders(c.req.raw.headers),
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    });

    const responseHeaders = new Headers(res.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("transfer-encoding");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error(`[Gateway] OpenCode proxy error for ${target}:`, err);
    return new Response(`OpenCode proxy error: ${err}`, { status: 502 });
  }
});

// Apply auth middleware to all proxied routes
app.use("/vscode/*", authMiddleware);
app.use("/vnc/*", authMiddleware);
app.use("/ttyd/*", authMiddleware);

// VS Code (code-server) proxy
app.all("/vscode/*", async (c) => {
  const path = c.req.path.replace(/^\/vscode/, "") || "/";
  const url = new URL(c.req.url);
  // Strip the token param from proxied request
  const searchParams = new URLSearchParams(url.search);
  searchParams.delete("token");
  const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const target = `http://127.0.0.1:8765${path}${cleanSearch}`;

  try {
    const res = await fetch(target, {
      method: c.req.method,
      headers: createProxyHeaders(c.req.raw.headers),
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    });

    // Return response without compression headers
    const responseHeaders = new Headers(res.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("transfer-encoding");

    const response = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });

    return addSessionCookie(response);
  } catch (err) {
    console.error(`[Gateway] VS Code proxy error for ${target}:`, err);
    return new Response(`VS Code proxy error: ${err}`, { status: 502 });
  }
});

// VNC (noVNC via websockify) proxy
app.all("/vnc/*", async (c) => {
  const path = c.req.path.replace(/^\/vnc/, "") || "/";
  const url = new URL(c.req.url);
  // Keep VNC query params (like path=, autoconnect=, resize=) but strip token
  const searchParams = new URLSearchParams(url.search);
  searchParams.delete("token");
  const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const target = `http://127.0.0.1:6080${path}${cleanSearch}`;

  try {
    const res = await fetch(target, {
      method: c.req.method,
      headers: createProxyHeaders(c.req.raw.headers),
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    });

    const responseHeaders = new Headers(res.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("transfer-encoding");

    const response = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });

    return addSessionCookie(response);
  } catch (err) {
    console.error(`[Gateway] VNC proxy error for ${target}:`, err);
    return new Response(`VNC proxy error: ${err}`, { status: 502 });
  }
});

// TTYD (web terminal) proxy
app.all("/ttyd/*", async (c) => {
  const path = c.req.path.replace(/^\/ttyd/, "") || "/";
  const url = new URL(c.req.url);
  // Strip the token param from proxied request to TTYD
  const searchParams = new URLSearchParams(url.search);
  searchParams.delete("token");
  const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const target = `http://127.0.0.1:7681${path}${cleanSearch}`;

  try {
    const res = await fetch(target, {
      method: c.req.method,
      headers: createProxyHeaders(c.req.raw.headers),
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    });

    const responseHeaders = new Headers(res.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("transfer-encoding");

    const response = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });

    return addSessionCookie(response);
  } catch (err) {
    console.error(`[Gateway] TTYD proxy error for ${target}:`, err);
    return new Response(`TTYD proxy error: ${err}`, { status: 502 });
  }
});

// ─── WebSocket Proxy ──────────────────────────────────────────────────────

interface WSTarget {
  host: string;
  port: number;
  path: string;
}

function resolveTunnel(name: string): { entry: TunnelEntry; requestedName: string; fallback: boolean } | null {
  const entry = tunnelRegistry.get(name);
  if (entry) return { entry, requestedName: name, fallback: false };
  if (tunnelRegistry.size === 1) {
    const only = Array.from(tunnelRegistry.values())[0];
    return { entry: only, requestedName: name, fallback: true };
  }
  return null;
}

function getWSTarget(pathname: string): WSTarget | null {
  const tunnelMatch = pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
  if (tunnelMatch) {
    const name = tunnelMatch[1];
    const resolved = resolveTunnel(name);
    if (!resolved) return null;
    const tail = tunnelMatch[2] || "/";
    const path = resolved.fallback ? `/${name}${tail}` : tail;
    return { host: "127.0.0.1", port: resolved.entry.port, path };
  }
  if (pathname.startsWith("/vscode")) {
    return { host: "127.0.0.1", port: 8765, path: pathname.replace(/^\/vscode/, "") || "/" };
  }
  if (pathname.startsWith("/vnc")) {
    return { host: "127.0.0.1", port: 6080, path: pathname.replace(/^\/vnc/, "") || "/" };
  }
  if (pathname.startsWith("/ttyd")) {
    return { host: "127.0.0.1", port: 7681, path: pathname.replace(/^\/ttyd/, "") || "/" };
  }
  return null;
}

// ─── Server ──────────────────────────────────────────────────────────────

// ─── Internal API (localhost-only, no auth) ──────────────────────────────

export interface SpawnChildParams {
  task: string;
  workspace: string;
  repoUrl?: string;
  branch?: string;
  ref?: string;
  title?: string;
  sourceType?: string;
  sourcePrNumber?: number;
  sourceIssueNumber?: number;
  sourceRepoFullName?: string;
  model?: string;
}

export interface MessageEntry {
  role: string;
  content: string;
  createdAt: string;
}

export interface CreatePullRequestParams {
  branch: string;
  title: string;
  body?: string;
  base?: string;
}

export interface CreatePullRequestResult {
  number: number;
  url: string;
  title: string;
  state: string;
}

export interface UpdatePullRequestParams {
  prNumber: number;
  title?: string;
  body?: string;
  state?: string;
  labels?: string[];
}

export interface UpdatePullRequestResult {
  number: number;
  url: string;
  title: string;
  state: string;
}

export interface ListPullRequestsParams {
  owner?: string;
  repo?: string;
  state?: "open" | "closed" | "all";
  limit?: number;
}

export interface InspectPullRequestParams {
  prNumber: number;
  owner?: string;
  repo?: string;
  filesLimit?: number;
  commentsLimit?: number;
}

export interface GitStateParams {
  branch?: string;
  baseBranch?: string;
  commitCount?: number;
}


export interface WorkflowSyncParams {
  id?: string;
  slug?: string;
  name: string;
  description?: string;
  version?: string;
  data: Record<string, unknown>;
}

export interface WorkflowRunParams {
  workflowId: string;
  variables?: Record<string, unknown>;
  repoUrl?: string;
  branch?: string;
  ref?: string;
  sourceRepoFullName?: string;
}

export interface TriggerSyncParams {
  triggerId?: string;
  workflowId?: string | null;
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  variableMapping?: Record<string, string>;
}

export interface TriggerRunParams {
  variables?: Record<string, unknown>;
  repoUrl?: string;
  branch?: string;
  ref?: string;
  sourceRepoFullName?: string;
}

export interface GatewayCallbacks {
  onImage?: (data: string, description: string) => void;
  onSpawnChild?: (params: SpawnChildParams) => Promise<{ childSessionId: string }>;
  onTerminateChild?: (childSessionId: string) => Promise<{ success: boolean }>;
  onSelfTerminate?: () => void;
  onSendMessage?: (targetSessionId: string, content: string, interrupt: boolean) => Promise<void>;
  onReadMessages?: (targetSessionId: string, limit?: number, after?: string) => Promise<MessageEntry[]>;
  onCreatePullRequest?: (params: CreatePullRequestParams) => Promise<CreatePullRequestResult>;
  onUpdatePullRequest?: (params: UpdatePullRequestParams) => Promise<UpdatePullRequestResult>;
  onListPullRequests?: (params: ListPullRequestsParams) => Promise<{ pulls: unknown[] }>;
  onInspectPullRequest?: (params: InspectPullRequestParams) => Promise<unknown>;
  onReportGitState?: (params: GitStateParams) => void;
  onMemRead?: (path: string) => Promise<{ file?: unknown; files?: unknown[]; content?: string }>;
  onMemWrite?: (path: string, content: string) => Promise<{ file: unknown }>;
  onMemPatch?: (path: string, operations: unknown[]) => Promise<{ result: unknown }>;
  onMemRm?: (path: string) => Promise<{ deleted: number }>;
  onMemSearch?: (query: string, path?: string, limit?: number) => Promise<{ results: unknown[] }>;
  onListRepos?: (source?: string) => Promise<{ repos: unknown[] }>;
  onListPersonas?: () => Promise<{ personas: unknown[] }>;
  onListChannels?: () => Promise<{ channels: unknown[] }>;
  onGetSessionStatus?: (targetSessionId: string) => Promise<{ sessionStatus: unknown }>;
  onListChildSessions?: () => Promise<{ children: unknown[] }>;
  onForwardMessages?: (targetSessionId: string, limit?: number, after?: string) => Promise<{ count: number; sourceSessionId: string }>;
  onReadRepoFile?: (params: { owner?: string; repo?: string; repoUrl?: string; path: string; ref?: string }) => Promise<{ content: string; encoding?: string; truncated?: boolean; path?: string; repo?: string; ref?: string }>;
  onListWorkflows?: () => Promise<{ workflows: unknown[] }>;
  onSyncWorkflow?: (params: WorkflowSyncParams) => Promise<{ success: boolean; workflow?: unknown }>;
  onGetWorkflow?: (workflowId: string) => Promise<{ workflow: unknown }>;
  onUpdateWorkflow?: (workflowId: string, payload: Record<string, unknown>) => Promise<{ workflow: unknown }>;
  onDeleteWorkflow?: (workflowId: string) => Promise<{ success: boolean }>;
  onRunWorkflow?: (params: WorkflowRunParams) => Promise<{ execution: unknown }>;
  onListWorkflowExecutions?: (workflowId?: string, limit?: number) => Promise<{ executions: unknown[] }>;
  onListTriggers?: (filters: { workflowId?: string; type?: string; enabled?: boolean }) => Promise<{ triggers: unknown[] }>;
  onSyncTrigger?: (params: TriggerSyncParams) => Promise<{ trigger?: unknown; success?: boolean }>;
  onRunTrigger?: (triggerId: string, params: TriggerRunParams) => Promise<Record<string, unknown>>;
  onDeleteTrigger?: (triggerId: string) => Promise<{ success: boolean }>;
  onGetExecution?: (executionId: string) => Promise<{ execution: unknown }>;
  onGetExecutionSteps?: (executionId: string) => Promise<{ steps: unknown[] }>;
  onApproveExecution?: (executionId: string, params: { approve: boolean; resumeToken: string; reason?: string }) => Promise<{ success: boolean; status?: string }>;
  onCancelExecution?: (executionId: string, params: { reason?: string }) => Promise<{ success: boolean; status?: string }>;
  onTunnelsUpdated?: (tunnels: TunnelDescriptor[]) => void;
  // Phase C: Mailbox + Task Board
  onMailboxSend?: (params: {
    toSessionId?: string;
    toUserId?: string;
    toHandle?: string;
    messageType?: string;
    content: string;
    contextSessionId?: string;
    contextTaskId?: string;
    replyToId?: string;
  }) => Promise<{ messageId: string }>;
  onMailboxCheck?: (limit?: number, after?: string) => Promise<{ messages: unknown[] }>;
  onTaskCreate?: (params: {
    title: string;
    description?: string;
    sessionId?: string;
    parentTaskId?: string;
    blockedBy?: string[];
  }) => Promise<{ task: unknown }>;
  onTaskList?: (params?: { status?: string; limit?: number }) => Promise<{ tasks: unknown[] }>;
  onTaskUpdate?: (taskId: string, updates: {
    status?: string;
    result?: string;
    description?: string;
    sessionId?: string;
    title?: string;
  }) => Promise<{ task: unknown }>;
  onMyTasks?: (status?: string) => Promise<{ tasks: unknown[] }>;
  // Phase D: Channel Reply
  onChannelReply?: (channelType: string, channelId: string, message: string, imageBase64?: string, imageMimeType?: string, followUp?: boolean) => Promise<{ success: boolean }>;
  // Tool Discovery & Invocation
  onListTools?: (service?: string, query?: string) => Promise<{ tools: unknown[]; warnings?: Array<{ service: string; displayName: string; reason: string; message: string }> }>;
  onCallTool?: (toolId: string, params: Record<string, unknown>) => Promise<{ result: unknown }>;
}

export function startGateway(port: number, callbacks: GatewayCallbacks): void {
  console.log(`[Gateway] Starting auth gateway on port ${port}`);
  tunnelRegistry.clear();

  function serializeTunnels(): TunnelDescriptor[] {
    return Array.from(tunnelRegistry.values()).map((entry) => ({
      ...entry,
      path: `/t/${entry.name}`,
    }));
  }

  function notifyTunnelsUpdated() {
    callbacks.onTunnelsUpdated?.(serializeTunnels());
  }

  // Image upload route (unauthenticated — only reachable from within the sandbox)
  app.post("/api/image", async (c) => {
    if (!callbacks.onImage) {
      return c.json({ error: "Image handler not configured" }, 500);
    }

    try {
      const body = await c.req.json() as { data: string; description?: string; mimeType?: string };
      if (!body.data) {
        return c.json({ error: "Missing 'data' field" }, 400);
      }

      callbacks.onImage(body.data, body.description || "Image");
      return c.json({ ok: true });
    } catch (err) {
      console.error("[Gateway] Image upload error:", err);
      return c.json({ error: "Invalid request body" }, 400);
    }
  });

  // ─── Tunnel Registry (sandbox-local) ───────────────────────────────

  app.get("/api/tunnels", async (c) => {
    return c.json({ tunnels: serializeTunnels() });
  });

  app.post("/api/tunnels", async (c) => {
    try {
      const body = await c.req.json() as { name?: string; port?: number; protocol?: TunnelProtocol };
      const name = (body.name || "").trim();
      const port = body.port;
      const protocol = body.protocol ?? "http";

      if (!name || !TUNNEL_NAME_RE.test(name)) {
        return c.json({ error: "Invalid tunnel name (1-32 chars: a-z A-Z 0-9 _ -)" }, 400);
      }
      if (!port || Number.isNaN(port) || port < 1 || port > 65535) {
        return c.json({ error: "Invalid port (1-65535)" }, 400);
      }
      if (!["http", "ws", "auto"].includes(protocol)) {
        return c.json({ error: "Invalid protocol (http | ws | auto)" }, 400);
      }

      tunnelRegistry.set(name, { name, port, protocol });
      notifyTunnelsUpdated();
      return c.json({ ok: true, tunnel: { name, port, protocol, path: `/t/${name}` } });
    } catch (err) {
      console.error("[Gateway] Register tunnel error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/tunnels/:name", async (c) => {
    const name = (c.req.param("name") || "").trim();
    if (!name) return c.json({ error: "Missing tunnel name" }, 400);

    if (!tunnelRegistry.has(name)) {
      return c.json({ error: "Tunnel not found" }, 404);
    }

    tunnelRegistry.delete(name);
    notifyTunnelsUpdated();
    return c.json({ ok: true });
  });

  // ─── Cross-Session API ─────────────────────────────────────────────

  app.post("/api/spawn-child", async (c) => {
    if (!callbacks.onSpawnChild) {
      return c.json({ error: "Spawn child handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { task?: string; workspace?: string; repoUrl?: string; branch?: string; ref?: string; title?: string; sourceType?: string; sourcePrNumber?: number; sourceIssueNumber?: number; sourceRepoFullName?: string; model?: string };
      if (!body.task || !body.workspace) {
        return c.json({ error: "Missing required fields: task, workspace" }, 400);
      }
      const result = await callbacks.onSpawnChild({
        task: body.task,
        workspace: body.workspace,
        repoUrl: body.repoUrl,
        branch: body.branch,
        ref: body.ref,
        title: body.title || body.workspace,
        sourceType: body.sourceType,
        sourcePrNumber: body.sourcePrNumber,
        sourceIssueNumber: body.sourceIssueNumber,
        sourceRepoFullName: body.sourceRepoFullName,
        model: body.model,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Spawn child error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/terminate-child", async (c) => {
    if (!callbacks.onTerminateChild) {
      return c.json({ error: "Terminate child handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { childSessionId?: string };
      if (!body.childSessionId) {
        return c.json({ error: "Missing required field: childSessionId" }, 400);
      }
      const result = await callbacks.onTerminateChild(body.childSessionId);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Terminate child error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/complete-session", async (c) => {
    if (!callbacks.onSelfTerminate) {
      return c.json({ error: "Self-terminate handler not configured" }, 500);
    }
    try {
      callbacks.onSelfTerminate();
      return c.json({ success: true });
    } catch (err) {
      console.error("[Gateway] Complete session error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/session-message", async (c) => {
    if (!callbacks.onSendMessage) {
      return c.json({ error: "Send message handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { sessionId?: string; content?: string; interrupt?: boolean };
      if (!body.sessionId || !body.content) {
        return c.json({ error: "Missing required fields: sessionId, content" }, 400);
      }
      await callbacks.onSendMessage(body.sessionId, body.content, body.interrupt ?? false);
      return c.json({ ok: true });
    } catch (err) {
      console.error("[Gateway] Send message error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/session-messages", async (c) => {
    if (!callbacks.onReadMessages) {
      return c.json({ error: "Read messages handler not configured" }, 500);
    }
    try {
      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return c.json({ error: "Missing required query param: sessionId" }, 400);
      }
      const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
      const after = c.req.query("after") || undefined;
      const messages = await callbacks.onReadMessages(sessionId, limit, after);
      return c.json({ messages });
    } catch (err) {
      console.error("[Gateway] Read messages error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── GitHub Lifecycle API ─────────────────────────────────────────

  app.post("/api/create-pull-request", async (c) => {
    if (!callbacks.onCreatePullRequest) {
      return c.json({ error: "Create pull request handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { branch?: string; title?: string; body?: string; base?: string };
      if (!body.branch || !body.title) {
        return c.json({ error: "Missing required fields: branch, title" }, 400);
      }
      const result = await callbacks.onCreatePullRequest({
        branch: body.branch,
        title: body.title,
        body: body.body,
        base: body.base,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Create pull request error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/update-pull-request", async (c) => {
    if (!callbacks.onUpdatePullRequest) {
      return c.json({ error: "Update pull request handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { pr_number?: number; title?: string; body?: string; state?: string; labels?: string[] };
      if (!body.pr_number) {
        return c.json({ error: "Missing required field: pr_number" }, 400);
      }
      const result = await callbacks.onUpdatePullRequest({
        prNumber: body.pr_number,
        title: body.title,
        body: body.body,
        state: body.state,
        labels: body.labels,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Update pull request error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/pull-requests", async (c) => {
    if (!callbacks.onListPullRequests) {
      return c.json({ error: "List pull requests handler not configured" }, 500);
    }
    try {
      const owner = c.req.query("owner") || undefined;
      const repo = c.req.query("repo") || undefined;
      const state = c.req.query("state") as "open" | "closed" | "all" | undefined;
      const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;

      if ((owner && !repo) || (!owner && repo)) {
        return c.json({ error: "Both owner and repo are required when targeting a specific repository" }, 400);
      }

      if (limit !== undefined && (Number.isNaN(limit) || limit < 1 || limit > 100)) {
        return c.json({ error: "limit must be between 1 and 100" }, 400);
      }

      if (state && !["open", "closed", "all"].includes(state)) {
        return c.json({ error: "state must be one of: open, closed, all" }, 400);
      }

      const result = await callbacks.onListPullRequests({ owner, repo, state, limit });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] List pull requests error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/pull-request", async (c) => {
    if (!callbacks.onInspectPullRequest) {
      return c.json({ error: "Inspect pull request handler not configured" }, 500);
    }
    try {
      const prNumberRaw = c.req.query("pr_number");
      if (!prNumberRaw) {
        return c.json({ error: "Missing required query param: pr_number" }, 400);
      }
      const prNumber = parseInt(prNumberRaw, 10);
      if (Number.isNaN(prNumber) || prNumber < 1) {
        return c.json({ error: "pr_number must be a positive integer" }, 400);
      }

      const owner = c.req.query("owner") || undefined;
      const repo = c.req.query("repo") || undefined;
      const filesLimit = c.req.query("files_limit") ? parseInt(c.req.query("files_limit")!, 10) : undefined;
      const commentsLimit = c.req.query("comments_limit") ? parseInt(c.req.query("comments_limit")!, 10) : undefined;

      if ((owner && !repo) || (!owner && repo)) {
        return c.json({ error: "Both owner and repo are required when targeting a specific repository" }, 400);
      }

      if (filesLimit !== undefined && (Number.isNaN(filesLimit) || filesLimit < 1 || filesLimit > 300)) {
        return c.json({ error: "files_limit must be between 1 and 300" }, 400);
      }

      if (commentsLimit !== undefined && (Number.isNaN(commentsLimit) || commentsLimit < 1 || commentsLimit > 300)) {
        return c.json({ error: "comments_limit must be between 1 and 300" }, 400);
      }

      const result = await callbacks.onInspectPullRequest({ prNumber, owner, repo, filesLimit, commentsLimit });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Inspect pull request error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/git-state", async (c) => {
    if (!callbacks.onReportGitState) {
      return c.json({ error: "Report git state handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { branch?: string; base_branch?: string; commit_count?: number };
      callbacks.onReportGitState({
        branch: body.branch,
        baseBranch: body.base_branch,
        commitCount: body.commit_count,
      });
      return c.json({ ok: true });
    } catch (err) {
      console.error("[Gateway] Report git state error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Orchestrator API ─────────────────────────────────────────────

  app.get("/api/memory", async (c) => {
    if (!callbacks.onMemRead) {
      return c.json({ error: "Memory read handler not configured" }, 500);
    }
    try {
      const path = c.req.query("path") || "";
      const result = await callbacks.onMemRead(path);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Memory read error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.put("/api/memory", async (c) => {
    if (!callbacks.onMemWrite) {
      return c.json({ error: "Memory write handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { path?: string; content?: string };
      if (!body.path || !body.content) {
        return c.json({ error: "Missing required fields: path, content" }, 400);
      }
      const result = await callbacks.onMemWrite(body.path, body.content);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Memory write error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.patch("/api/memory", async (c) => {
    if (!callbacks.onMemPatch) {
      return c.json({ error: "Memory patch handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { path?: string; operations?: unknown[] };
      if (!body.path || !body.operations) {
        return c.json({ error: "Missing required fields: path, operations" }, 400);
      }
      const result = await callbacks.onMemPatch(body.path, body.operations);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Memory patch error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/memory", async (c) => {
    if (!callbacks.onMemRm) {
      return c.json({ error: "Memory delete handler not configured" }, 500);
    }
    try {
      const path = c.req.query("path");
      if (!path) {
        return c.json({ error: "Missing required query param: path" }, 400);
      }
      const result = await callbacks.onMemRm(path);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Memory delete error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/memory/search", async (c) => {
    if (!callbacks.onMemSearch) {
      return c.json({ error: "Memory search handler not configured" }, 500);
    }
    try {
      const query = c.req.query("query");
      if (!query) {
        return c.json({ error: "Missing required query param: query" }, 400);
      }
      const path = c.req.query("path") || undefined;
      const limitParam = c.req.query("limit");
      const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 20, 50) : 20;
      const result = await callbacks.onMemSearch(query, path, limit);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Memory search error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/org-repos", async (c) => {
    if (!callbacks.onListRepos) {
      return c.json({ error: "List repos handler not configured" }, 500);
    }
    try {
      const source = c.req.query("source") || undefined;
      const result = await callbacks.onListRepos(source);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] List repos error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/personas", async (c) => {
    if (!callbacks.onListPersonas) {
      return c.json({ error: "List personas handler not configured" }, 500);
    }
    try {
      const result = await callbacks.onListPersonas();
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] List personas error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/channels", async (c) => {
    if (!callbacks.onListChannels) {
      return c.json({ error: "List channels handler not configured" }, 500);
    }
    try {
      const result = await callbacks.onListChannels();
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] List channels error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/session-status", async (c) => {
    if (!callbacks.onGetSessionStatus) {
      return c.json({ error: "Get session status handler not configured" }, 500);
    }
    try {
      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return c.json({ error: "Missing required query param: sessionId" }, 400);
      }
      const result = await callbacks.onGetSessionStatus(sessionId);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Get session status error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/child-sessions", async (c) => {
    if (!callbacks.onListChildSessions) {
      return c.json({ error: "List child sessions handler not configured" }, 500);
    }
    try {
      const result = await callbacks.onListChildSessions();
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] List child sessions error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/forward-messages", async (c) => {
    if (!callbacks.onForwardMessages) {
      return c.json({ error: "Forward messages handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { sessionId?: string; limit?: number; after?: string };
      if (!body.sessionId) {
        return c.json({ error: "Missing required field: sessionId" }, 400);
      }
      const result = await callbacks.onForwardMessages(body.sessionId, body.limit, body.after);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Forward messages error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/read-repo-file", async (c) => {
    if (!callbacks.onReadRepoFile) {
      return c.json({ error: "Read repo file handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { owner?: string; repo?: string; repoUrl?: string; path?: string; ref?: string };
      if (!body.path) {
        return c.json({ error: "Missing required field: path" }, 400);
      }
      const result = await callbacks.onReadRepoFile({
        owner: body.owner,
        repo: body.repo,
        repoUrl: body.repoUrl,
        path: body.path,
        ref: body.ref,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Read repo file error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Workflow API ───────────────────────────────────────────────────

  app.get("/api/workflows", async (c) => {
    if (!callbacks.onListWorkflows) {
      return c.json({ error: "List workflows handler not configured" }, 500);
    }
    try {
      const result = await callbacks.onListWorkflows();
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] List workflows error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/workflows/sync", async (c) => {
    if (!callbacks.onSyncWorkflow) {
      return c.json({ error: "Sync workflow handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as {
        id?: string;
        slug?: string;
        name?: string;
        description?: string;
        version?: string;
        data?: Record<string, unknown>;
      };
      if (!body.name || !body.data || typeof body.data !== "object") {
        return c.json({ error: "Missing required fields: name, data" }, 400);
      }
      const result = await callbacks.onSyncWorkflow({
        id: body.id,
        slug: body.slug,
        name: body.name,
        description: body.description,
        version: body.version,
        data: body.data,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Sync workflow error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/workflows/run", async (c) => {
    if (!callbacks.onRunWorkflow) {
      return c.json({ error: "Run workflow handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as {
        workflowId?: string;
        variables?: Record<string, unknown>;
        repoUrl?: string;
        branch?: string;
        ref?: string;
        sourceRepoFullName?: string;
      };
      if (!body.workflowId) {
        return c.json({ error: "Missing required field: workflowId" }, 400);
      }
      const result = await callbacks.onRunWorkflow({
        workflowId: body.workflowId,
        variables: body.variables,
        repoUrl: body.repoUrl,
        branch: body.branch,
        ref: body.ref,
        sourceRepoFullName: body.sourceRepoFullName,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Run workflow error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/workflows/executions", async (c) => {
    if (!callbacks.onListWorkflowExecutions) {
      return c.json({ error: "List workflow executions handler not configured" }, 500);
    }
    try {
      const workflowId = c.req.query("workflowId") || undefined;
      const limitRaw = c.req.query("limit");
      const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
      if (limit !== undefined && (Number.isNaN(limit) || limit < 1 || limit > 200)) {
        return c.json({ error: "limit must be between 1 and 200" }, 400);
      }
      const result = await callbacks.onListWorkflowExecutions(workflowId, limit);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] List workflow executions error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/workflows/:id", async (c) => {
    if (!callbacks.onGetWorkflow) {
      return c.json({ error: "Get workflow handler not configured" }, 500);
    }
    try {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing workflow id" }, 400);
      const result = await callbacks.onGetWorkflow(id);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Get workflow error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.put("/api/workflows/:id", async (c) => {
    if (!callbacks.onUpdateWorkflow) {
      return c.json({ error: "Update workflow handler not configured" }, 500);
    }
    try {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing workflow id" }, 400);
      const body = await c.req.json() as Record<string, unknown>;
      const result = await callbacks.onUpdateWorkflow(id, body || {});
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Update workflow error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/workflows/:id", async (c) => {
    if (!callbacks.onDeleteWorkflow) {
      return c.json({ error: "Delete workflow handler not configured" }, 500);
    }
    try {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing workflow id" }, 400);
      const result = await callbacks.onDeleteWorkflow(id);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Delete workflow error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Trigger API ───────────────────────────────────────────────────

  app.get("/api/triggers", async (c) => {
    if (!callbacks.onListTriggers) {
      return c.json({ error: "List triggers handler not configured" }, 500);
    }
    try {
      const workflowId = c.req.query("workflowId") || undefined;
      const type = c.req.query("type") || undefined;
      const enabledRaw = c.req.query("enabled");
      const enabled = enabledRaw === undefined ? undefined : enabledRaw === "true";
      const result = await callbacks.onListTriggers({ workflowId, type, enabled });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] List triggers error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/triggers", async (c) => {
    if (!callbacks.onSyncTrigger) {
      return c.json({ error: "Sync trigger handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as {
        workflowId?: string | null;
        name?: string;
        enabled?: boolean;
        config?: Record<string, unknown>;
        variableMapping?: Record<string, string>;
      };
      if (!body.name || !body.config || typeof body.config !== "object") {
        return c.json({ error: "Missing required fields: name, config" }, 400);
      }
      const result = await callbacks.onSyncTrigger({
        workflowId: body.workflowId,
        name: body.name,
        enabled: body.enabled,
        config: body.config,
        variableMapping: body.variableMapping,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Create trigger error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.patch("/api/triggers/:id", async (c) => {
    if (!callbacks.onSyncTrigger) {
      return c.json({ error: "Sync trigger handler not configured" }, 500);
    }
    try {
      const triggerId = c.req.param("id");
      if (!triggerId) return c.json({ error: "Missing trigger id" }, 400);
      const body = await c.req.json() as {
        workflowId?: string | null;
        name?: string;
        enabled?: boolean;
        config?: Record<string, unknown>;
        variableMapping?: Record<string, string>;
      };
      const patchPayload: TriggerSyncParams = { triggerId };
      if (Object.prototype.hasOwnProperty.call(body, "workflowId")) patchPayload.workflowId = body.workflowId ?? null;
      if (Object.prototype.hasOwnProperty.call(body, "name") && body.name) patchPayload.name = body.name;
      if (Object.prototype.hasOwnProperty.call(body, "enabled")) patchPayload.enabled = body.enabled;
      if (Object.prototype.hasOwnProperty.call(body, "config") && body.config) patchPayload.config = body.config;
      if (Object.prototype.hasOwnProperty.call(body, "variableMapping") && body.variableMapping) patchPayload.variableMapping = body.variableMapping;
      const result = await callbacks.onSyncTrigger(patchPayload);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Update trigger error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/triggers/:id/run", async (c) => {
    if (!callbacks.onRunTrigger) {
      return c.json({ error: "Run trigger handler not configured" }, 500);
    }
    try {
      const triggerId = c.req.param("id");
      if (!triggerId) return c.json({ error: "Missing trigger id" }, 400);
      const body = await c.req.json() as {
        variables?: Record<string, unknown>;
        repoUrl?: string;
        branch?: string;
        ref?: string;
        sourceRepoFullName?: string;
      };
      const result = await callbacks.onRunTrigger(triggerId, {
        variables: body.variables,
        repoUrl: body.repoUrl,
        branch: body.branch,
        ref: body.ref,
        sourceRepoFullName: body.sourceRepoFullName,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Run trigger error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/triggers/:id", async (c) => {
    if (!callbacks.onDeleteTrigger) {
      return c.json({ error: "Delete trigger handler not configured" }, 500);
    }
    try {
      const triggerId = c.req.param("id");
      if (!triggerId) return c.json({ error: "Missing trigger id" }, 400);
      const result = await callbacks.onDeleteTrigger(triggerId);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Delete trigger error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Phase C: Notification Queue API ───────────────────────────────

  app.post("/api/notifications/emit", async (c) => {
    if (!callbacks.onMailboxSend) {
      return c.json({ error: "Notification emit handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as {
        to_session_id?: string;
        to_user_id?: string;
        to_handle?: string;
        message_type?: "notification" | "question" | "escalation" | "approval";
        content?: string;
        context_session_id?: string;
        context_task_id?: string;
        reply_to_id?: string;
      };
      if (!body.content) {
        return c.json({ error: "Missing required field: content" }, 400);
      }
      if (!body.to_session_id && !body.to_user_id && !body.to_handle) {
        return c.json({ error: "Must specify to_session_id, to_user_id, or to_handle" }, 400);
      }
      const result = await callbacks.onMailboxSend({
        toSessionId: body.to_session_id,
        toUserId: body.to_user_id,
        toHandle: body.to_handle,
        messageType: body.message_type || "notification",
        content: body.content,
        contextSessionId: body.context_session_id,
        contextTaskId: body.context_task_id,
        replyToId: body.reply_to_id,
      });
      return c.json({ notificationId: result.messageId, messageId: result.messageId });
    } catch (err) {
      console.error("[Gateway] Notification emit error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/notifications", async (c) => {
    if (!callbacks.onMailboxCheck) {
      return c.json({ error: "Notification queue handler not configured" }, 500);
    }
    try {
      const limitRaw = c.req.query("limit");
      const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
      const after = c.req.query("after") || undefined;
      const result = await callbacks.onMailboxCheck(limit, after);
      return c.json({ notifications: result.messages ?? [] });
    } catch (err) {
      console.error("[Gateway] Notification queue check error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Phase C: Task Board API ─────────────────────────────────────

  app.post("/api/tasks", async (c) => {
    if (!callbacks.onTaskCreate) {
      return c.json({ error: "Task create handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as {
        title?: string;
        description?: string;
        session_id?: string;
        parent_task_id?: string;
        blocked_by?: string[];
      };
      if (!body.title) {
        return c.json({ error: "Missing required field: title" }, 400);
      }
      const result = await callbacks.onTaskCreate({
        title: body.title,
        description: body.description,
        sessionId: body.session_id,
        parentTaskId: body.parent_task_id,
        blockedBy: body.blocked_by,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Task create error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/tasks", async (c) => {
    if (!callbacks.onTaskList) {
      return c.json({ error: "Task list handler not configured" }, 500);
    }
    try {
      const status = c.req.query("status") || undefined;
      const limitRaw = c.req.query("limit");
      const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
      const result = await callbacks.onTaskList({ status, limit });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Task list error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.put("/api/tasks/:id", async (c) => {
    if (!callbacks.onTaskUpdate) {
      return c.json({ error: "Task update handler not configured" }, 500);
    }
    try {
      const taskId = c.req.param("id");
      if (!taskId) return c.json({ error: "Missing task id" }, 400);
      const body = await c.req.json() as {
        status?: string;
        result?: string;
        description?: string;
        session_id?: string;
        title?: string;
      };
      const result = await callbacks.onTaskUpdate(taskId, {
        status: body.status,
        result: body.result,
        description: body.description,
        sessionId: body.session_id,
        title: body.title,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Task update error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/my-tasks", async (c) => {
    if (!callbacks.onMyTasks) {
      return c.json({ error: "My tasks handler not configured" }, 500);
    }
    try {
      const status = c.req.query("status") || undefined;
      const result = await callbacks.onMyTasks(status);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] My tasks error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Phase D: Channel Reply API ────────────────────────────────────

  app.post("/api/channel-reply", async (c) => {
    if (!callbacks.onChannelReply) {
      return c.json({ error: "Channel reply handler not configured" }, 501);
    }
    try {
      const body = await c.req.json() as { channelType?: string; channelId?: string; message?: string; imageBase64?: string; imageMimeType?: string; followUp?: boolean };
      if (!body.channelType || !body.channelId || (!body.message && !body.imageBase64)) {
        return c.json({ error: "channelType, channelId, and message or image are required" }, 400);
      }
      const result = await callbacks.onChannelReply(body.channelType, body.channelId, body.message || '', body.imageBase64, body.imageMimeType, body.followUp);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Channel reply error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Tool Discovery & Invocation API ─────────────────────────────────

  app.get("/api/tools", async (c) => {
    if (!callbacks.onListTools) {
      return c.json({ error: "List tools handler not configured" }, 500);
    }
    try {
      const service = c.req.query("service") || undefined;
      const query = c.req.query("query") || undefined;
      const result = await callbacks.onListTools(service, query);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] List tools error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/tools/call", async (c) => {
    if (!callbacks.onCallTool) {
      return c.json({ error: "Call tool handler not configured" }, 500);
    }
    try {
      const body = await c.req.json() as { toolId?: string; params?: Record<string, unknown> };
      if (!body.toolId) {
        return c.json({ error: "Missing required field: toolId" }, 400);
      }
      const result = await callbacks.onCallTool(body.toolId, body.params || {});
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Call tool error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Secrets API (provider-agnostic) ─────────────────────────────────

  app.get("/api/secrets/list", async (c) => {
    try {
      const secrets = await import("./secrets.js");
      if (!(await secrets.isConfigured())) {
        return c.json({ error: "No secrets provider configured" }, 501);
      }
      const vaultId = c.req.query("vaultId") || undefined;
      const entries = await secrets.listSecrets(vaultId);
      return c.json({ secrets: entries });
    } catch (err) {
      console.error("[Gateway] Secrets list error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/secrets/inject", async (c) => {
    try {
      const secrets = await import("./secrets.js");
      if (!(await secrets.isConfigured())) {
        return c.json({ error: "No secrets provider configured" }, 501);
      }
      const body = await c.req.json() as { templatePath?: string; outputPath?: string };
      if (!body.templatePath || !body.outputPath) {
        return c.json({ error: "Missing required fields: templatePath, outputPath" }, 400);
      }
      const result = await secrets.injectSecretsIntoFile(body.templatePath, body.outputPath);
      return c.json({ ok: true, ...result });
    } catch (err) {
      console.error("[Gateway] Secrets inject error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/secrets/run", async (c) => {
    try {
      const secrets = await import("./secrets.js");
      if (!(await secrets.isConfigured())) {
        return c.json({ error: "No secrets provider configured" }, 501);
      }
      const body = await c.req.json() as {
        command?: string;
        env?: Record<string, string>;
        cwd?: string;
        timeout?: number;
      };
      if (!body.command || !body.env) {
        return c.json({ error: "Missing required fields: command, env" }, 400);
      }
      const result = await secrets.runWithSecrets(body.command, body.env, {
        cwd: body.cwd,
        timeout: body.timeout,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Secrets run error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/secrets/fill", async (c) => {
    try {
      const secrets = await import("./secrets.js");
      if (!(await secrets.isConfigured())) {
        return c.json({ error: "No secrets provider configured" }, 501);
      }
      const body = await c.req.json() as {
        selector?: string;
        secret_ref?: string;
        timeout?: number;
      };
      if (!body.selector || !body.secret_ref) {
        return c.json({ error: "Missing required fields: selector, secret_ref" }, 400);
      }
      const result = await secrets.fillBrowserField(body.selector, body.secret_ref, {
        timeout: body.timeout,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Secrets fill error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Execution API ─────────────────────────────────────────────────

  app.get("/api/executions/:id", async (c) => {
    if (!callbacks.onGetExecution) {
      return c.json({ error: "Get execution handler not configured" }, 500);
    }
    try {
      const executionId = c.req.param("id");
      if (!executionId) return c.json({ error: "Missing execution id" }, 400);
      const result = await callbacks.onGetExecution(executionId);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Get execution error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/executions/:id/steps", async (c) => {
    if (!callbacks.onGetExecutionSteps) {
      return c.json({ error: "Get execution steps handler not configured" }, 500);
    }
    try {
      const executionId = c.req.param("id");
      if (!executionId) return c.json({ error: "Missing execution id" }, 400);
      const result = await callbacks.onGetExecutionSteps(executionId);
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Get execution steps error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/executions/:id/approve", async (c) => {
    if (!callbacks.onApproveExecution) {
      return c.json({ error: "Approve execution handler not configured" }, 500);
    }
    try {
      const executionId = c.req.param("id");
      if (!executionId) return c.json({ error: "Missing execution id" }, 400);
      const body = await c.req.json() as { approve?: boolean; resumeToken?: string; reason?: string };
      if (typeof body.approve !== "boolean" || !body.resumeToken) {
        return c.json({ error: "Missing required fields: approve, resumeToken" }, 400);
      }
      const result = await callbacks.onApproveExecution(executionId, {
        approve: body.approve,
        resumeToken: body.resumeToken,
        reason: body.reason,
      });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Approve execution error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/executions/:id/cancel", async (c) => {
    if (!callbacks.onCancelExecution) {
      return c.json({ error: "Cancel execution handler not configured" }, 500);
    }
    try {
      const executionId = c.req.param("id");
      if (!executionId) return c.json({ error: "Missing execution id" }, 400);
      const body = await c.req.json() as { reason?: string };
      const result = await callbacks.onCancelExecution(executionId, { reason: body.reason });
      return c.json(result);
    } catch (err) {
      console.error("[Gateway] Cancel execution error:", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Apply auth middleware to all tunnel routes
  app.use("/t/*", authMiddleware);
  app.use("/t/:name", authMiddleware);

  // Tunnel proxy
  app.all("/t/:name", async (c) => {
    const name = c.req.param("name");
    const resolved = resolveTunnel(name);
    if (!resolved) return new Response("Tunnel not found", { status: 404 });

    const url = new URL(c.req.url);
    const searchParams = new URLSearchParams(url.search);
    searchParams.delete("token");
    const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : "";
    const backendPath = resolved.fallback ? `/${name}` : "/";
    const target = `http://127.0.0.1:${resolved.entry.port}${backendPath}${cleanSearch}`;

    try {
      const res = await fetch(target, {
        method: c.req.method,
        headers: createProxyHeaders(c.req.raw.headers),
        body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      });

      const responseHeaders = new Headers(res.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("transfer-encoding");

      const response = new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      });

      return addSessionCookie(response);
    } catch (err) {
      console.error(`[Gateway] Tunnel proxy error for /t/${name}:`, err);
      return new Response(`Tunnel proxy error: ${err}`, { status: 502 });
    }
  });

  app.all("/t/:name/*", async (c) => {
    const name = c.req.param("name");
    const resolved = resolveTunnel(name);
    if (!resolved) return new Response("Tunnel not found", { status: 404 });

    const path = c.req.path.replace(new RegExp(`^/t/${name}`), "") || "/";
    const url = new URL(c.req.url);
    const searchParams = new URLSearchParams(url.search);
    searchParams.delete("token");
    const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : "";
    const backendPath = resolved.fallback ? `/${name}${path}` : path;
    const target = `http://127.0.0.1:${resolved.entry.port}${backendPath}${cleanSearch}`;

    try {
      const res = await fetch(target, {
        method: c.req.method,
        headers: createProxyHeaders(c.req.raw.headers),
        body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      });

      const responseHeaders = new Headers(res.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("transfer-encoding");

      const response = new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      });

      return addSessionCookie(response);
    } catch (err) {
      console.error(`[Gateway] Tunnel proxy error for /t/${name}${path}:`, err);
      return new Response(`Tunnel proxy error: ${err}`, { status: 502 });
    }
  });

  Bun.serve({
    port,
    // Gateway proxies long-running operations (tool calls up to 30s, approval
    // gates up to 11min). Bun's default 10s idle timeout closes the HTTP socket
    // before the handler responds, causing "socket closed unexpectedly" errors.
    idleTimeout: 255,

    async fetch(req: Request, server: any): Promise<Response> {
      const url = new URL(req.url);
      const upgrade = req.headers.get("upgrade")?.toLowerCase();

      // Handle WebSocket upgrades
      if (upgrade === "websocket") {
        const target = getWSTarget(url.pathname);
        if (!target) {
          return new Response("Not found", { status: 404 });
        }

        // Check session cookie first for WebSocket connections
        const cookies = parseCookies(req.headers.get("Cookie"));
        const sessionToken = cookies[SESSION_COOKIE];

        if (sessionToken && validateSession(sessionToken)) {
          // Valid session - upgrade WebSocket
          const success = server.upgrade(req, {
            data: { target, url: url.toString() },
          });
          if (success) return undefined as any;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        // No valid session - need JWT token
        const token = url.searchParams.get("token") || req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          return new Response(JSON.stringify({ error: "Missing token" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const payload = await verifyJWT(token, jwtSecret());
        if (!payload) {
          return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Get the requested subprotocol from client (e.g., "tty" for TTYD)
        const requestedProtocol = req.headers.get("Sec-WebSocket-Protocol");

        // Upgrade to WebSocket and proxy to backend
        const success = server.upgrade(req, {
          data: { target, url: url.toString(), protocol: requestedProtocol },
          headers: requestedProtocol ? { "Sec-WebSocket-Protocol": requestedProtocol } : undefined,
        });

        if (success) {
          return undefined as any; // Bun will handle the upgrade
        }
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Handle regular HTTP requests via Hono
      return app.fetch(req);
    },

    websocket: {
      open(ws: any) {
        const { target, url } = ws.data as { target: WSTarget; url: string };
        const parsedUrl = new URL(url);
        // Strip token from WebSocket URL - backend services don't need it
        const searchParams = new URLSearchParams(parsedUrl.search);
        searchParams.delete("token");
        const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : "";
        const wsUrl = `ws://${target.host}:${target.port}${target.path}${cleanSearch}`;

        // Buffer for messages that arrive before backend is connected
        const messageBuffer: (string | Buffer)[] = [];
        (ws as any).messageBuffer = messageBuffer;
        (ws as any).backendReady = false;

        // Connect to backend WebSocket
        // TTYD requires the "tty" subprotocol to be specified
        const protocols = target.port === 7681 ? ["tty"] : undefined;
        const backend = protocols
          ? new WebSocket(wsUrl, protocols)
          : new WebSocket(wsUrl);
        // Ensure binary data is received as ArrayBuffer for proper forwarding
        backend.binaryType = "arraybuffer";

        backend.onopen = () => {
          (ws as any).backendReady = true;

          // Flush any buffered messages
          const buffer = (ws as any).messageBuffer as (string | Buffer)[];
          if (buffer.length > 0) {
            for (const msg of buffer) {
              backend.send(msg);
            }
            buffer.length = 0;
          }
        };

        backend.onmessage = (event) => {
          try {
            ws.send(event.data);
          } catch (e) {
            console.error("[Gateway] Error forwarding to client:", e);
          }
        };

        backend.onclose = (event) => {
          try {
            ws.close(event.code, event.reason);
          } catch {
            // Client may already be closed
          }
        };

        backend.onerror = (error) => {
          console.error("[Gateway] Backend WS error:", error);
          try {
            ws.close(1011, "Backend error");
          } catch {
            // Client may already be closed
          }
        };

        // Store backend connection for message forwarding
        (ws as any).backend = backend;
      },

      message(ws: any, message: string | Buffer) {
        const backend = (ws as any).backend as WebSocket;
        const backendReady = (ws as any).backendReady as boolean;
        const messageBuffer = (ws as any).messageBuffer as (string | Buffer)[];

        if (backendReady && backend && backend.readyState === WebSocket.OPEN) {
          backend.send(message);
        } else if (messageBuffer) {
          // Buffer message until backend is ready
          messageBuffer.push(message);
        }
      },

      close(ws: any, code: number, reason: string) {
        const backend = (ws as any).backend as WebSocket;
        if (backend) {
          try {
            backend.close(code, reason);
          } catch {
            // May already be closed
          }
        }
      },
    },
  });
}
