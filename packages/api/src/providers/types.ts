import type {
  BlobStore,
  CredentialStore,
  EventBus,
  SandboxProvider,
  SessionStore,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";

/**
 * The full set of capabilities the API needs at runtime. Built once at boot,
 * injected per-request via `providersMiddleware`. Routes touch
 * `c.var.providers.X`; services accept `Pick<Providers, ...>` to declare the
 * exact subset they need.
 */
export interface Providers {
  db: AppDb;
  blobs: BlobStore;
  encryptionKey: string;

  // Engine-side providers — same family that @valet/engine consumes.
  engineStore: SessionStore;
  sandboxProvider: SandboxProvider;
  eventBus: EventBus;
  engineCredentials: CredentialStore;

  // Per-process Engine cache. Lives only on the server, not in engine.
  engineHost: EngineHost;
}
