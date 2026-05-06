import { VirtualSandboxProvider } from "./providers/sandbox/virtual.js";
import { Session } from "./session.js";
import type {
  CreateSessionOptions,
  EngineOptions,
  RestoreSessionOptions,
  Sandbox,
  SandboxCreateOpts,
} from "./types.js";

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export class Engine {
  private sessions = new Map<string, Session>();
  private opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  async createSession(opts: CreateSessionOptions): Promise<Session> {
    const id = opts.id ?? uid("sess");
    if (this.sessions.has(id)) return this.sessions.get(id)!;

    const sandbox = await this.materializeSandbox(opts.sandbox);
    const session = new Session(id, opts, this.opts.providers, sandbox);
    this.sessions.set(id, session);

    await this.opts.providers.store.saveSession(await session.toData());
    return session;
  }

  async restoreSession(args: RestoreSessionOptions): Promise<Session> {
    const cached = this.sessions.get(args.sessionId);
    if (cached) return cached;
    const data = await this.opts.providers.store.getSession(args.sessionId);
    if (!data) throw new Error(`session not found: ${args.sessionId}`);
    const sandbox = await this.materializeSandbox(args.options.sandbox);
    const session = await Session.rehydrate(
      data,
      { ...args.options, id: args.sessionId },
      this.opts.providers,
      sandbox,
    );
    this.sessions.set(args.sessionId, session);
    return session;
  }

  getSession(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) await s.destroy();
    this.sessions.delete(sessionId);
  }

  private async materializeSandbox(
    arg: Sandbox | SandboxCreateOpts | undefined,
  ): Promise<Sandbox> {
    if (arg && typeof (arg as Sandbox).readFile === "function") {
      return arg as Sandbox;
    }
    const provider = this.opts.providers.sandboxProvider ?? new VirtualSandboxProvider();
    return provider.create((arg ?? {}) as SandboxCreateOpts);
  }
}
