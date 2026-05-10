import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryEventBus,
} from "@valet/engine";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import { SqliteSessionStore, applyEngineMigrations } from "@valet/store-sqlite";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { EngineHost } from "../engine/host.js";
import { FsBlobStore } from "./blob-fs.js";
import type { Providers } from "./types.js";

export interface NodeProviderOpts {
  /** Path to the sqlite file holding both app + engine schemas. */
  dbPath: string;
  /** Directory root for the filesystem-backed blob store. */
  blobsRoot: string;
  /** Encryption key used by helpers that store sensitive data. */
  encryptionKey: string;
  /**
   * Anthropic API key for the engine's LLM calls. Required for prompts to
   * actually run; leave undefined for read-only routes.
   */
  anthropicApiKey?: string;
}

export const LOCAL_USER = {
  id: "local-user",
  email: "local@dev",
  name: "Local Dev",
  role: "admin" as const,
};

export const LOCAL_ORG = {
  id: "local-org",
  name: "Local Dev",
};

/**
 * Open the sqlite database, run app + engine migrations, seed the local
 * dev identity, and construct every provider the API + engine need.
 *
 * The same sqlite file holds both schemas — table names don't collide
 * (`engine_*` vs application names) so they coexist cleanly.
 */
export async function buildNodeProviders(opts: NodeProviderOpts): Promise<Providers> {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  mkdirSync(opts.blobsRoot, { recursive: true });

  const sqlite = new Database(opts.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  applyAppMigrations(sqlite);
  applyEngineMigrations(sqlite);

  // Seed the local-dev identity. Idempotent.
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)",
    )
    .run(LOCAL_ORG.id, LOCAL_ORG.name, now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(LOCAL_USER.id, LOCAL_USER.email, LOCAL_USER.name, LOCAL_USER.role, now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)",
    )
    .run(LOCAL_ORG.id, LOCAL_USER.id, "admin");

  // Two Drizzle handles: one for the app schema, one for the engine schema.
  // Same connection underneath; Drizzle's per-handle config is local.
  const db = buildAppDb(sqlite);
  const engineDb = drizzle(sqlite);

  const engineStore = new SqliteSessionStore(engineDb);
  const blobs = new FsBlobStore(opts.blobsRoot);
  const sandboxProvider = new DockerSandboxProvider();
  const eventBus = new InMemoryEventBus();
  const engineCredentials = new InMemoryCredentialStore();

  const engineHost = new EngineHost({
    engineStore,
    sandboxProvider,
    eventBus,
    engineCredentials,
    blobs,
    anthropicApiKey: opts.anthropicApiKey,
  });

  return {
    db,
    blobs,
    encryptionKey: opts.encryptionKey,
    engineStore,
    sandboxProvider,
    eventBus,
    engineCredentials,
    engineHost,
  };
}
