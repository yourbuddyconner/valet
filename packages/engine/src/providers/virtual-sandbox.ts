import type { ExecOpts, ExecResult, Sandbox, SandboxCreateOpts, SandboxProvider, SandboxStatus } from "../types.js";

interface FsEntry {
  type: "file" | "dir";
  content?: Uint8Array;
}

function normalize(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  const parts = path.split("/").filter((p) => p && p !== ".");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return "/" + stack.join("/");
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * In-memory sandbox for tests. Shell commands are intentionally minimal —
 * just enough to exercise the engine without containers:
 *   echo, cat, ls, pwd, true, false, sh -c "<above>"
 * Anything else returns exitCode 127.
 */
export class VirtualSandbox implements Sandbox {
  readonly id: string;
  private fs = new Map<string, FsEntry>();
  private cwd = "/";

  constructor(id: string) {
    this.id = id;
    this.fs.set("/", { type: "dir" });
  }

  private ensureParentDirs(path: string): void {
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur += "/" + parts[i];
      if (!this.fs.has(cur)) this.fs.set(cur, { type: "dir" });
    }
  }

  async readFile(path: string): Promise<string> {
    return dec.decode(await this.readBinary(path));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const e = this.fs.get(normalize(path));
    if (!e || e.type !== "file" || !e.content) throw new Error(`ENOENT: ${path}`);
    return e.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.writeBinary(path, enc.encode(content));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const norm = normalize(path);
    this.ensureParentDirs(norm);
    this.fs.set(norm, { type: "file", content: data });
  }

  async readdir(path: string): Promise<string[]> {
    const norm = normalize(path);
    if (!this.fs.has(norm)) throw new Error(`ENOENT: ${path}`);
    const prefix = norm === "/" ? "/" : norm + "/";
    const names = new Set<string>();
    for (const k of this.fs.keys()) {
      if (k === norm) continue;
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [...names];
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    const e = this.fs.get(normalize(path));
    if (!e) throw new Error(`ENOENT: ${path}`);
    return {
      isFile: e.type === "file",
      isDirectory: e.type === "dir",
      size: e.content?.length ?? 0,
    };
  }

  async mkdir(path: string): Promise<void> {
    const norm = normalize(path);
    this.ensureParentDirs(norm);
    if (!this.fs.has(norm)) this.fs.set(norm, { type: "dir" });
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const norm = normalize(path);
    const e = this.fs.get(norm);
    if (!e) return;
    if (e.type === "dir" && opts?.recursive) {
      const prefix = norm === "/" ? "/" : norm + "/";
      for (const k of [...this.fs.keys()]) if (k.startsWith(prefix)) this.fs.delete(k);
    }
    this.fs.delete(norm);
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ?? this.cwd;
    const out = await runVirtualCommand(this, command, cwd);
    if (opts?.maxOutputBytes && out.stdout.length > opts.maxOutputBytes) {
      return { ...out, stdout: out.stdout.slice(0, opts.maxOutputBytes), truncated: true };
    }
    return out;
  }

  async snapshot(): Promise<string> {
    return `${this.id}@${Date.now()}`;
  }

  async tunnels(): Promise<Record<string, string>> {
    return {};
  }

  async destroy(): Promise<void> {
    this.fs.clear();
  }
}

async function runVirtualCommand(sb: VirtualSandbox, command: string, cwd: string): Promise<ExecResult> {
  // Strip "sh -c '...'" wrapping
  const shMatch = command.match(/^\s*(?:bash|sh)\s+-c\s+(['"])([\s\S]*)\1\s*$/);
  const inner = shMatch ? shMatch[2] : command;
  const trimmed = inner.trim();

  if (trimmed === "true" || trimmed === ":") return ok("");
  if (trimmed === "false") return { stdout: "", stderr: "", exitCode: 1 };
  if (trimmed === "pwd") return ok(cwd + "\n");

  const echoMatch = trimmed.match(/^echo\s+(.*)$/);
  if (echoMatch) {
    const arg = echoMatch[1].replace(/^['"]|['"]$/g, "");
    return ok(arg + "\n");
  }

  const catMatch = trimmed.match(/^cat\s+(\S+)$/);
  if (catMatch) {
    try {
      const content = await sb.readFile(resolveRel(cwd, catMatch[1]));
      return ok(content);
    } catch (e) {
      return { stdout: "", stderr: `cat: ${(e as Error).message}\n`, exitCode: 1 };
    }
  }

  const lsMatch = trimmed.match(/^ls(?:\s+(\S+))?$/);
  if (lsMatch) {
    const target = lsMatch[1] ? resolveRel(cwd, lsMatch[1]) : cwd;
    try {
      const names = await sb.readdir(target);
      return ok(names.sort().join("\n") + (names.length ? "\n" : ""));
    } catch (e) {
      return { stdout: "", stderr: `ls: ${(e as Error).message}\n`, exitCode: 2 };
    }
  }

  return { stdout: "", stderr: `command not found: ${trimmed}\n`, exitCode: 127 };
}

function resolveRel(cwd: string, p: string): string {
  if (p.startsWith("/")) return p;
  return cwd === "/" ? "/" + p : cwd + "/" + p;
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

// ── Provider ──────────────────────────────────────────────────────

export class VirtualSandboxProvider implements SandboxProvider {
  private sandboxes = new Map<string, VirtualSandbox>();
  private nextId = 1;

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    const id = `vsb-${this.nextId++}`;
    const sb = new VirtualSandbox(id);
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`virtual sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (sb) await sb.destroy?.();
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id)
      ? { id, state: "running", startedAt: Date.now() }
      : { id, state: "stopped" };
  }
}
