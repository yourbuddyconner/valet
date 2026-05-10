import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandboxProvider, type DockerSandboxCreateOpts } from "../src/index.js";

/** Skip the whole suite when Docker isn't available locally. */
function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    stdio: "pipe",
  });
  return r.status === 0;
}

const dockerHere = dockerAvailable();
const describeDocker = dockerHere ? describe : describe.skip;

let tmp: string;
let provider: DockerSandboxProvider;

describeDocker("DockerSandbox", () => {
  beforeAll(() => {
    if (!dockerHere) {
      // eslint-disable-next-line no-console
      console.warn("docker not available — DockerSandbox tests skipped");
    }
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "valet-docker-"));
    provider = new DockerSandboxProvider();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function makeSandbox(extra: Partial<DockerSandboxCreateOpts> = {}) {
    return (await provider.create({
      workspace: tmp,
      // Use the smallest possible image to keep CI cold-start fast.
      image: "alpine:3.20",
      ...extra,
    })) as InstanceType<typeof import("../src/index.js").DockerSandbox>;
  }

  it("create + destroy lifecycle works", async () => {
    const sb = await makeSandbox();
    expect(sb.id.startsWith("dsb-")).toBe(true);
    expect(sb.containerId.length).toBeGreaterThan(8);
    const status = await provider.status(sb.id);
    expect(status.state).toBe("running");
    await provider.destroy(sb.id);
    const stopped = await provider.status(sb.id);
    expect(stopped.state).toBe("stopped");
  });

  it("filesystem ops execute against the host bind-mount", async () => {
    const sb = await makeSandbox();
    try {
      await sb.writeFile("note.txt", "hello from host");
      // The file is visible on the host because of the bind mount.
      expect(await readFile(join(tmp, "note.txt"), "utf8")).toBe("hello from host");
      // …and visible from inside the container too.
      const inside = await sb.exec("cat /workspace/note.txt");
      expect(inside.exitCode).toBe(0);
      expect(inside.stdout).toBe("hello from host");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("FS ops accept container paths (e.g. /workspace/foo)", async () => {
    // The agent often shells out via bash (which sees /workspace) and then
    // tries to read the file back via the FS tools. The container path
    // should resolve to the same host file as a relative path.
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("echo container-write > /workspace/from-bash.txt");
      expect(r.exitCode).toBe(0);
      expect(await sb.readFile("/workspace/from-bash.txt")).toBe("container-write\n");
      expect(await sb.readFile("from-bash.txt")).toBe("container-write\n");

      await sb.writeFile("/workspace/from-fs.txt", "fs-write");
      expect(await readFile(join(tmp, "from-fs.txt"), "utf8")).toBe("fs-write");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("exec runs commands inside the container", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("uname -s && hostname");
      expect(r.exitCode).toBe(0);
      // alpine's uname says "Linux"; the host (this test process) runs darwin.
      expect(r.stdout).toContain("Linux");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("default cwd is the bind-mounted workspace", async () => {
    const sb = await makeSandbox();
    try {
      await writeFile(join(tmp, "marker"), "");
      const r = await sb.exec("ls");
      expect(r.stdout).toContain("marker");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("non-zero exit codes propagate", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("false");
      expect(r.exitCode).not.toBe(0);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("times out long-running commands", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("sleep 10", { timeout: 500 });
      expect(r.timedOut).toBe(true);
      expect(r.exitCode).not.toBe(0);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("aborts via signal", async () => {
    const sb = await makeSandbox();
    try {
      const ac = new AbortController();
      const promise = sb.exec("sleep 10", { signal: ac.signal });
      setTimeout(() => ac.abort(), 200);
      const r = await promise;
      expect(r.exitCode).not.toBe(0);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("truncates stdout to maxOutputBytes", async () => {
    const sb = await makeSandbox();
    try {
      // Print 50_000 bytes; cap at 1_000.
      const r = await sb.exec(
        "printf 'x%.0s' $(seq 1 50000)",
        { maxOutputBytes: 1_000 },
      );
      expect(r.stdout.length).toBeLessThanOrEqual(1_000);
      expect(r.truncated).toBe(true);
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("pipes stdin into the child process", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("cat", { stdin: "piped-input\n" });
      expect(r.stdout).toBe("piped-input\n");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("merges per-call env over container env", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.exec("echo $VALET_TEST_VAR", {
        env: { VALET_TEST_VAR: "from-test" },
      });
      expect(r.stdout.trim()).toBe("from-test");
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("resolves symlinked workspace paths (e.g. /tmp on macOS)", async () => {
    // Without symlink resolution, Docker Desktop on macOS silently maps the
    // bind mount to a different path than node:fs sees, so writes through
    // the container never appear on the host (and vice versa).
    const real = await mkdtemp(join(tmp, "real-"));
    const link = join(tmp, "linked");
    await symlink(real, link);
    const sb = await provider.create({ workspace: link, image: "alpine:3.20" });
    try {
      await (sb as InstanceType<typeof import("../src/index.js").DockerSandbox>).exec(
        "echo from-container > /workspace/marker.txt",
      );
      // Visible on the *real* host path, even though we passed the symlink.
      expect(await readFile(join(real, "marker.txt"), "utf8")).toBe(
        "from-container\n",
      );
    } finally {
      await provider.destroy(sb.id);
    }
  });

  it("rejects when workspace is missing or not a directory", async () => {
    // Cast to bypass the type guard — runtime validation is the contract.
    await expect(
      provider.create({} as DockerSandboxCreateOpts),
    ).rejects.toThrow(/workspace is required/);
    const file = join(tmp, "not-a-dir.txt");
    await writeFile(file, "x");
    await expect(provider.create({ workspace: file })).rejects.toThrow(/not a directory/);
  });
});
