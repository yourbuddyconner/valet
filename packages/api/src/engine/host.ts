import { getModel, type Model } from "@mariozechner/pi-ai";
import {
  Engine,
  type BlobStore,
  type CredentialStore,
  type EventBus,
  type SandboxProvider,
  type Session,
  type SessionStore,
} from "@valet/engine";

export interface EngineHostOpts {
  engineStore: SessionStore;
  sandboxProvider: SandboxProvider;
  eventBus: EventBus;
  engineCredentials: CredentialStore;
  blobs?: BlobStore;
  /** Anthropic API key required for prompts. Without it, prompts fail. */
  anthropicApiKey?: string;
  /** pi-ai model id; defaults to claude-haiku-4-5 for fast dogfooding. */
  defaultModelId?: string;
  /** Default Docker image for new sandboxes. */
  defaultImage?: string;
}

export interface SessionMeta {
  userId: string;
  orgId: string;
  workspace: string;
}

interface CacheEntry {
  engine: Engine;
  session: Session;
}

const SYSTEM_PROMPT =
  "You are a helpful coding assistant running inside a Docker sandbox. " +
  "Your workspace is /workspace (the only mounted directory). " +
  "All read/write/edit/bash tools operate against /workspace — use absolute " +
  "paths under /workspace or relative paths (which resolve there). " +
  "You have built-in tools: read, write, edit, bash, thread_read. Be concise.";

/**
 * Per-process cache of live `Engine`/`Session` pairs keyed by app session id.
 * One Engine instance per session keeps the engine's internal lifecycle
 * simple. Calling `sessionFor` multiple times for the same id returns the
 * same Session.
 */
export class EngineHost {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly opts: EngineHostOpts) {}

  /**
   * Resolve (or lazily create) the Session for an app session id. If the
   * engine store already has a row for this id, restore it. Otherwise create
   * a new engine session and persist it via the store.
   */
  async sessionFor(sessionId: string, meta: SessionMeta): Promise<Session> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached.session;

    const model = this.resolveModel();

    const engine = new Engine({
      providers: {
        store: this.opts.engineStore,
        bus: this.opts.eventBus,
        credentials: this.opts.engineCredentials,
        sandboxProvider: this.opts.sandboxProvider,
        blobs: this.opts.blobs,
      },
    });

    const existing = await this.opts.engineStore.getSession(sessionId);
    const session = existing
      ? await engine.restoreSession({
          sessionId,
          options: {
            userId: meta.userId,
            orgId: meta.orgId,
            workspace: meta.workspace,
            sandbox: { workspace: meta.workspace, image: this.opts.defaultImage },
            model,
            systemPrompt: SYSTEM_PROMPT,
          },
        })
      : await engine.createSession({
          id: sessionId,
          userId: meta.userId,
          orgId: meta.orgId,
          workspace: meta.workspace,
          sandbox: { workspace: meta.workspace, image: this.opts.defaultImage },
          model,
          systemPrompt: SYSTEM_PROMPT,
        });

    this.cache.set(sessionId, { engine, session });
    return session;
  }

  /** Tear down a single session: destroy engine + sandbox, drop the cache entry. */
  async destroy(sessionId: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    try {
      await entry.session.destroy();
    } finally {
      this.cache.delete(sessionId);
    }
  }

  /** Tear down every live session. Call from process shutdown handlers. */
  async destroyAll(): Promise<void> {
    const ids = [...this.cache.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  /** True if a session is currently cached in this process. */
  isLive(sessionId: string): boolean {
    return this.cache.has(sessionId);
  }

  private resolveModel(): Model<any> {
    const id = this.opts.defaultModelId ?? "claude-haiku-4-5";
    // pi-ai's getModel is typed against its compile-time MODELS table; we
    // accept user-configurable ids and cast at the boundary. The engine
    // accepts Model<any> so the api-level type stays open.
    const model = getModel("anthropic", id as "claude-haiku-4-5");
    if (!model) {
      throw new Error(
        `EngineHost: unknown anthropic model "${id}" — check pi-ai MODELS or VALET_MODEL env`,
      );
    }
    return model;
  }
}
