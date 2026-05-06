import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  ExecOpts,
  ExecResult,
  Sandbox,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";

/**
 * DockerSandbox runs shell commands inside a long-running Docker container,
 * with the workspace bind-mounted from the host. Filesystem operations
 * (read/write/edit/stat/etc.) execute on the host against the mounted
 * directory — fast, no protocol overhead — while exec() goes through
 * `docker exec`. This gives real container isolation for shell while
 * keeping FS reads cheap.
 *
 * Lifetime: one container per sandbox, started on create() and removed
 * on destroy(). Restarts are not preserved across the engine's
 * restoreSession path; the host re-creates a fresh container.
 *
 * Networking: defaults to bridge (the LocalSandbox-equivalent posture).
 * Override via DockerSandboxCreateOpts.network.
 *
 * Security: bind-mounting + bridge networking gives the container the
 * same data and outbound network access as the host process. For
 * production deployments (untrusted prompts), use --network=none and
 * a workspace dedicated to the session.
 */

const DEFAULT_IMAGE = "node:20-bookworm";
const CONTAINER_PREFIX = "valet-sandbox-";

export interface DockerSandboxCreateOpts extends SandboxCreateOpts {
  /** Workspace dir on the host. Required. Bind-mounted at /workspace inside the container. */
  workspace: string;
  /** Container image. Default: node:20-bookworm. */
  image?: string;
  /** Docker network mode. "bridge" (default), "none", "host", or a named network. */
  network?: string;
  /** Extra env vars to inject into the container at start time. */
  env?: Record<string, string>;
  /** Pull the image before creating the container if it isn't local. Default: true. */
  pullIfMissing?: boolean;
}

export interface DockerSandboxOptions {
  /** Container id assigned by Docker. */
  containerId: string;
  /** Resolved workspace path on the host. */
  workspace: string;
  /** Workspace path inside the container. */
  containerWorkspace: string;
  /** Image used to start the container. */
  image: string;
}

const CONTAINER_WORKSPACE = "/workspace";

export class DockerSandbox implements Sandbox {
  readonly id: string;
  readonly workspace: string;
  readonly containerId: string;
  readonly containerWorkspace: string;
  readonly image: string;

  constructor(id: string, opts: DockerSandboxOptions) {
    this.id = id;
    this.containerId = opts.containerId;
    this.workspace = opts.workspace;
    this.containerWorkspace = opts.containerWorkspace;
    this.image = opts.image;
  }

  /**
   * Translate any path the agent might hand us (host absolute, container
   * absolute, or workspace-relative) into the host-side path that node:fs
   * can open. Keeps the user's mental model symmetric with bash, which
   * sees the workspace at `/workspace` inside the container.
   */
  private resolveHostPath(p: string): string {
    if (!isAbsolute(p)) return resolve(this.workspace, p);
    const cw = this.containerWorkspace;
    if (p === cw) return this.workspace;
    const cwSlash = cw.endsWith("/") ? cw : cw + "/";
    if (p.startsWith(cwSlash)) {
      return resolve(this.workspace, p.slice(cwSlash.length));
    }
    return p;
  }

  /**
   * Translate a host-side path to its container-side path. Only paths
   * inside the workspace are exposed inside the container; absolute paths
   * outside the workspace are left as-is, and exec() picks them up only
   * if the container actually has them (it doesn't for a stock image).
   */
  private resolveContainerPath(p: string): string {
    if (isAbsolute(p)) {
      const ws = this.workspace.endsWith("/") ? this.workspace : this.workspace + "/";
      if (p === this.workspace) return this.containerWorkspace;
      if (p.startsWith(ws)) {
        return this.containerWorkspace + "/" + p.slice(ws.length);
      }
      return p; // best-effort; only exists if the host path exists in the container
    }
    return p; // relative paths are resolved against the container's cwd (= containerWorkspace)
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(this.resolveHostPath(path), "utf8");
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.resolveHostPath(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.resolveHostPath(path);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const target = this.resolveHostPath(path);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  async readdir(path: string): Promise<string[]> {
    return fs.readdir(this.resolveHostPath(path));
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    const s = await fs.stat(this.resolveHostPath(path));
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(this.resolveHostPath(path), { recursive: true });
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await fs.rm(this.resolveHostPath(path), {
      recursive: opts?.recursive ?? false,
      force: true,
    });
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ? this.resolveContainerPath(opts.cwd) : this.containerWorkspace;
    const args = ["exec"];
    args.push("--workdir", cwd);
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("--env", `${k}=${v}`);
      }
    }
    if (opts?.stdin !== undefined) args.push("--interactive");
    args.push(this.containerId, "sh", "-c", command);

    return execProcess("docker", args, {
      timeout: opts?.timeout,
      signal: opts?.signal,
      stdin: opts?.stdin,
      maxOutputBytes: opts?.maxOutputBytes,
    });
  }

  async snapshot(): Promise<string> {
    return `${this.id}@${Date.now()}`;
  }

  async tunnels(): Promise<Record<string, string>> {
    return {};
  }

  async destroy(): Promise<void> {
    // `docker rm -f` stops + removes; idempotent.
    try {
      await execProcess("docker", ["rm", "-f", this.containerId], {});
    } catch {
      // already gone
    }
  }
}

function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx <= 0 ? "/" : p.slice(0, idx);
}

interface ExecProcessOpts {
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
}

/**
 * Spawn a process and capture stdout/stderr. Honors timeout (SIGKILL),
 * abort signal, optional stdin, and maxOutputBytes truncation. Reused
 * for both `docker run` setup and `docker exec` runtime calls.
 */
function execProcess(
  bin: string,
  args: string[],
  opts: ExecProcessOpts,
): Promise<ExecResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child: ChildProcess = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const limit = opts.maxOutputBytes;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      if (limit && stdout.length >= limit) {
        truncated = true;
        return;
      }
      stdout += chunk;
      if (limit && stdout.length > limit) {
        stdout = stdout.slice(0, limit);
        truncated = true;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (limit && stderr.length >= limit) return;
      stderr += chunk;
      if (limit && stderr.length > limit) stderr = stderr.slice(0, limit);
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeout);
      const t = timer as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
    }

    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      rejectResult(err);
    });

    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const exitCode = code ?? (sig ? 128 : 1);
      resolveResult({
        stdout,
        stderr,
        exitCode,
        timedOut: timedOut ? true : undefined,
        truncated: truncated ? true : undefined,
      });
    });
  });
}

// ── Provider ──────────────────────────────────────────────────────

export class DockerSandboxProvider implements SandboxProvider {
  private sandboxes = new Map<string, DockerSandbox>();
  private nextId = 1;

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    const dockerOpts = opts as DockerSandboxCreateOpts;
    const workspace = dockerOpts.workspace;
    if (!workspace) {
      throw new Error(
        "DockerSandboxProvider.create: opts.workspace is required (absolute host path).",
      );
    }
    const requested = isAbsolute(workspace) ? workspace : resolve(workspace);
    const stat = await fs.stat(requested);
    if (!stat.isDirectory()) {
      throw new Error(
        `DockerSandboxProvider.create: workspace is not a directory: ${requested}`,
      );
    }
    // Resolve symlinks so the bind mount survives macOS's /tmp → /private/tmp
    // indirection. Docker Desktop refuses to follow the symlink itself, so
    // a bind from /tmp/foo silently maps to a separate, empty volume on the
    // host side — node:fs ops on the host then can't see what the container
    // wrote and vice versa. Always pass the realpath to `docker run -v`.
    const abs = await fs.realpath(requested);

    const image = dockerOpts.image ?? DEFAULT_IMAGE;
    const network = dockerOpts.network ?? "bridge";
    const id = `dsb-${this.nextId++}`;
    const containerName = `${CONTAINER_PREFIX}${id}-${Date.now()}`;

    if (dockerOpts.pullIfMissing !== false) {
      await ensureImage(image);
    }

    const runArgs: string[] = ["run", "-d", "--name", containerName];
    runArgs.push("--workdir", CONTAINER_WORKSPACE);
    runArgs.push("-v", `${abs}:${CONTAINER_WORKSPACE}`);
    if (network !== "bridge") runArgs.push("--network", network);
    if (dockerOpts.env) {
      for (const [k, v] of Object.entries(dockerOpts.env)) {
        runArgs.push("--env", `${k}=${v}`);
      }
    }
    if (opts.resources?.cpu) runArgs.push("--cpus", String(opts.resources.cpu));
    if (opts.resources?.memory) runArgs.push("--memory", opts.resources.memory);
    runArgs.push(image);
    // Keep the container alive — most images exit immediately if PID 1 is
    // an interactive shell and there's no TTY. `tail -f /dev/null` is a
    // tiny long-running placeholder; `docker exec` does the actual work.
    runArgs.push("sh", "-c", "tail -f /dev/null");

    const startResult = await execProcess("docker", runArgs, {});
    if (startResult.exitCode !== 0) {
      throw new Error(
        `docker run failed (${startResult.exitCode}): ${startResult.stderr.trim() || startResult.stdout.trim()}`,
      );
    }
    const containerId = startResult.stdout.trim();

    const sb = new DockerSandbox(id, {
      containerId,
      workspace: abs,
      containerWorkspace: CONTAINER_WORKSPACE,
      image,
    });
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`DockerSandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (sb) await sb.destroy?.();
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    const sb = this.sandboxes.get(id);
    if (!sb) return { id, state: "stopped" };
    const inspect = await execProcess(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", sb.containerId],
      {},
    );
    if (inspect.exitCode !== 0) return { id, state: "stopped" };
    return inspect.stdout.trim() === "true"
      ? { id, state: "running", startedAt: Date.now() }
      : { id, state: "stopped" };
  }
}

async function ensureImage(image: string): Promise<void> {
  // `docker image inspect` exits 0 if the image is local, non-zero otherwise.
  const probe = await execProcess("docker", ["image", "inspect", image], {});
  if (probe.exitCode === 0) return;
  const pull = await execProcess("docker", ["pull", image], { timeout: 120_000 });
  if (pull.exitCode !== 0) {
    throw new Error(
      `docker pull ${image} failed: ${pull.stderr.trim() || pull.stdout.trim()}`,
    );
  }
}
