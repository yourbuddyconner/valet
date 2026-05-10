/**
 * Shared boot harness for API integration tests.
 *
 * Spins up a real `createApp(providers)` on a random port with in-memory
 * sqlite + virtual sandbox + InMemory bus/creds. Returns the base URLs and
 * a cleanup function tests can call in `finally`.
 *
 * Underscore-prefixed filename so vitest's `*.test.ts` glob doesn't pick it
 * up as a test.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  InMemoryCredentialStore,
  InMemoryEventBus,
  VirtualSandboxProvider,
} from "@valet/engine";
import { SqliteSessionStore, applyEngineMigrations } from "@valet/store-sqlite";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { EngineHost } from "../engine/host.js";
import { FsBlobStore } from "../providers/blob-fs.js";
import { createApp } from "../app.js";
import type { Providers } from "../providers/types.js";

export interface TestApi {
  baseUrl: string;
  wsUrl: string;
  providers: Providers;
  cleanup(): Promise<void>;
}

export async function bootTestApi(): Promise<TestApi> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
  process.env.VALET_LOCAL_AUTH = "1";

  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  applyAppMigrations(sqlite);
  applyEngineMigrations(sqlite);

  // Seed the local-dev identity (mirrors buildNodeProviders).
  const now = Date.now();
  sqlite
    .prepare("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)")
    .run("local-org", "Local Dev", now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("local-user", "local@dev", "Local Dev", "admin", now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)",
    )
    .run("local-org", "local-user", "admin");

  const blobsRoot = mkdtempSync(join(tmpdir(), "valet-itest-blobs-"));

  const db = buildAppDb(sqlite);
  const engineDb = drizzle(sqlite);
  const engineStore = new SqliteSessionStore(engineDb);
  const sandboxProvider = new VirtualSandboxProvider();
  const eventBus = new InMemoryEventBus();
  const engineCredentials = new InMemoryCredentialStore();
  const blobs = new FsBlobStore(blobsRoot);

  const engineHost = new EngineHost({
    engineStore,
    sandboxProvider,
    eventBus,
    engineCredentials,
    blobs,
    anthropicApiKey: ANTHROPIC_API_KEY,
  });

  const providers: Providers = {
    db,
    blobs,
    encryptionKey: "test-key",
    engineStore,
    sandboxProvider,
    eventBus,
    engineCredentials,
    engineHost,
  };

  const { app, injectWebSocket } = createApp(providers);
  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);

  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}`,
    providers,
    async cleanup() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await engineHost.destroyAll();
      rmSync(blobsRoot, { recursive: true, force: true });
    },
  };
}
