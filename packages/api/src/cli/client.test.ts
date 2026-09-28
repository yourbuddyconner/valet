import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstanceClient } from "./client.js";
import { ApiError, AuthError, UnreachableError } from "./exit.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
let lastRequest: { method?: string; url?: string; headers: IncomingMessage["headers"] } | null;

beforeEach(async () => {
  lastRequest = null;
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  };
  server = createServer((req, res) => {
    lastRequest = { method: req.method, url: req.url, headers: req.headers };
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("InstanceClient auth header", () => {
  it("sends x-api-key on every request when apiKey is set", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "valet-api", ts: 123 }));
    };
    const client = new InstanceClient({ url: baseUrl, apiKey: "vlt_secret" });
    const health = await client.health();

    expect(lastRequest?.headers["x-api-key"]).toBe("vlt_secret");
    expect(health.ok).toBe(true);
    expect(health.service).toBe("valet-api");
    expect(health.ts).toBe(123);
  });

  it("omits x-api-key when apiKey is undefined (local stub)", async () => {
    const client = new InstanceClient({ url: baseUrl });
    await client.health();
    expect(lastRequest?.headers["x-api-key"]).toBeUndefined();
    // content-type is still sent.
    expect(lastRequest?.headers["content-type"]).toBe("application/json");
  });
});

describe("InstanceClient.ensureOrchestrator", () => {
  it("posts /api/workspaces/user/runtime for a personal identity", async () => {
    const calls: string[] = [];
    handler = (req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/me") {
        res.end(JSON.stringify({ id: "u1", email: "u@x", name: "U", role: "member", orgId: "org1" }));
        return;
      }
      res.end(JSON.stringify({ sessionId: "assistant:u1" }));
    };
    const client = new InstanceClient({ url: baseUrl, apiKey: "vlt_personal" });
    expect((await client.ensureOrchestrator()).sessionId).toBe("assistant:u1");
    expect(calls).toContain("POST /api/workspaces/user/runtime");
    expect(calls.some((c) => c.startsWith("POST /api/teams/"))).toBe(false);
  });

  it("posts the team's orchestrator for a team identity", async () => {
    const calls: string[] = [];
    handler = (req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/me") {
        res.end(JSON.stringify({ id: "team_1", name: "Platform", role: "team", orgId: "org1" }));
        return;
      }
      res.end(JSON.stringify({ sessionId: "assistant:team_1" }));
    };
    const client = new InstanceClient({ url: baseUrl, apiKey: "vlt_team" });
    expect((await client.ensureOrchestrator()).sessionId).toBe("assistant:team_1");
    expect(calls).toContain("POST /api/workspaces/team_1/runtime");
    expect(calls).not.toContain("POST /api/workspaces/user/runtime");
  });
});

describe("InstanceClient error mapping", () => {
  it("maps 401 to AuthError", async () => {
    handler = (_req, res) => {
      res.writeHead(401);
      res.end("nope");
    };
    const client = new InstanceClient({ url: baseUrl, apiKey: "vlt_bad" });
    await expect(client.me()).rejects.toBeInstanceOf(AuthError);
  });

  it("maps a non-2xx to ApiError carrying status + body", async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end("kaboom");
    };
    const client = new InstanceClient({ url: baseUrl });
    const err = await client.listSessions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    if (err instanceof ApiError) {
      expect(err.status).toBe(500);
      expect(err.body).toBe("kaboom");
    }
  });

  it("maps a refused connection to UnreachableError", async () => {
    // Port 1 is reserved/unbound on the loopback → ECONNREFUSED.
    const client = new InstanceClient({ url: "http://127.0.0.1:1" });
    await expect(client.health()).rejects.toBeInstanceOf(UnreachableError);
  });
});

describe("InstanceClient typed round-trips", () => {
  it("round-trips a 200 JSON body into the typed response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          messages: [
            {
              id: "m1",
              sessionId: "s1",
              threadId: "t1",
              role: "user",
              content: "hello",
              parts: [{ kind: "text", text: "hello" }],
              createdAt: 42,
            },
          ],
          hasMore: false,
        }),
      );
    };
    const client = new InstanceClient({ url: baseUrl, apiKey: "vlt_k" });
    const res = await client.listMessages("s1", { threadId: "t1", limit: 10 });

    expect(res.hasMore).toBe(false);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].content).toBe("hello");
    // Query params were passed through on the request line.
    expect(lastRequest?.url).toContain("threadId=t1");
    expect(lastRequest?.url).toContain("limit=10");
    expect(lastRequest?.url).toContain("/api/sessions/s1/messages");
  });

  it("normalizes a trailing slash in the base url", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, service: "valet-api", ts: 1 }));
    };
    const client = new InstanceClient({ url: `${baseUrl}/` });
    await client.health();
    expect(lastRequest?.url).toBe("/api/health");
  });
});
