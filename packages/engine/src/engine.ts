import { VirtualSandboxProvider } from "./providers/virtual-sandbox.js";
import { Session } from "./session.js";
import type {
  CreateSessionOptions,
  EngineOptions,
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

  async restoreSession(sessionId: string): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const data = await this.opts.providers.store.getSession(sessionId);
    if (!data) throw new Error(`session not found: ${sessionId}`);
    // V1 prototype: full restoration of pending queue items / suspended turns
    // is a follow-up. Here we only rehydrate the session shell.
    throw new Error("restoreSession: not implemented in prototype yet");
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
