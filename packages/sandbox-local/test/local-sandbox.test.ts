import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSandbox, LocalSandboxProvider } from "../src/index.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "valet-engine-localsb-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("LocalSandbox: filesystem", () => {
  it("write + read round-trips a file", async () => {
    const sb = new LocalSandbox("test", tmp);
    await sb.writeFile("note.txt", "hello world");
    expect(await sb.readFile("note.txt")).toBe("hello world");
    expect(await readFile(join(tmp, "note.txt"), "utf8")).toBe("hello world");
  });

  it("resolves relative paths against the workspace cwd", async () => {
    const sb = new LocalSandbox("test", tmp);
    await sb.writeFile("a/b/c.txt", "deep");
    expect(await readFile(join(tmp, "a", "b", "c.txt"), "utf8")).toBe("deep");
  });

  it("absolute paths bypass the workspace prefix", async () => {
    // This is intentionally permissive: LocalSandbox is for dev/testing.
    const sb = new LocalSandbox("test", tmp);
    const outside = join(tmp, "..", "valet-localsb-outside.txt");
    await sb.writeFile(outside, "ok");
    expect(await readFile(outside, "utf8")).toBe("ok");
    await rm(outside, { force: true });
  });

  it("readdir + stat + mkdir + rm", async () => {
    const sb = new LocalSandbox("test", tmp);
    await sb.mkdir("subdir");
    await sb.writeFile("subdir/file.txt", "x");
    const entries = await sb.readdir("subdir");
    expect(entries).toEqual(["file.txt"]);
    const s = await sb.stat("subdir/file.txt");
    expect(s).toEqual({ isFile: true, isDirectory: false, size: 1 });
    await sb.rm("subdir", { recursive: true });
    await expect(sb.readdir("subdir")).rejects.toThrow();
  });

  it("readBinary + writeBinary round-trips bytes", async () => {
    const sb = new LocalSandbox("test", tmp);
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await sb.writeBinary("blob.bin", bytes);
    const out = await sb.readBinary("blob.bin");
    expect(Array.from(out)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});

describe("LocalSandbox: exec", () => {
  it("runs a simple command and captures stdout", async () => {
    const sb = new LocalSandbox("test", tmp);
    const res = await sb.exec("echo hi");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
  });

  it("inherits PATH so common tools work", async () => {
    const sb = new LocalSandbox("test", tmp);
    const res = await sb.exec("node -e \"console.log(2+2)\"");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("4");
  });

  it("captures non-zero exit codes", async () => {
    const sb = new LocalSandbox("test", tmp);
    const res = await sb.exec("false");
    expect(res.exitCode).not.toBe(0);
  });

  it("sets cwd to the workspace by default", async () => {
    const sb = new LocalSandbox("test", tmp);
    await writeFile(join(tmp, "marker"), "");
    const res = await sb.exec("ls");
    expect(res.stdout).toContain("marker");
  });

  it("honors per-call cwd override (relative to workspace)", async () => {
    const sb = new LocalSandbox("test", tmp);
    await mkdir(join(tmp, "sub"));
    await writeFile(join(tmp, "sub", "x"), "");
    const res = await sb.exec("ls", { cwd: "sub" });
    expect(res.stdout).toContain("x");
  });

  it("merges per-call env over process env", async () => {
    const sb = new LocalSandbox("test", tmp);
    const res = await sb.exec("echo $VALET_TEST_VAR", {
      env: { VALET_TEST_VAR: "from-test" },
    });
    expect(res.stdout.trim()).toBe("from-test");
  });

  it("times out and reports timedOut=true", async () => {
    const sb = new LocalSandbox("test", tmp);
    const res = await sb.exec("sleep 5", { timeout: 80 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  });

  it("aborts via signal", async () => {
    const sb = new LocalSandbox("test", tmp);
    const ac = new AbortController();
    const promise = sb.exec("sleep 5", { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const res = await promise;
    expect(res.exitCode).not.toBe(0);
  });

  it("truncates stdout to maxOutputBytes", async () => {
    const sb = new LocalSandbox("test", tmp);
    // Print 50_000 bytes; cap at 1000.
    const res = await sb.exec(
      "node -e \"process.stdout.write('x'.repeat(50000))\"",
      { maxOutputBytes: 1000 },
    );
    expect(res.stdout.length).toBeLessThanOrEqual(1000);
    expect(res.truncated).toBe(true);
  });

  it("pipes stdin into the child process", async () => {
    const sb = new LocalSandbox("test", tmp);
    const res = await sb.exec("cat", { stdin: "piped-input\n" });
    expect(res.stdout).toBe("piped-input\n");
  });
});

describe("LocalSandboxProvider", () => {
  it("creates a LocalSandbox bound to the workspace", async () => {
    const provider = new LocalSandboxProvider();
    const sb = await provider.create({ workspace: tmp });
    expect(sb.id.startsWith("local-")).toBe(true);
    await sb.writeFile("hello.txt", "yo");
    expect(await readFile(join(tmp, "hello.txt"), "utf8")).toBe("yo");
  });

  it("rejects when workspace is missing", async () => {
    const provider = new LocalSandboxProvider();
    await expect(provider.create({})).rejects.toThrow(/workspace is required/);
  });

  it("rejects when workspace is not a directory", async () => {
    const provider = new LocalSandboxProvider();
    const file = join(tmp, "notadir.txt");
    await writeFile(file, "x");
    await expect(provider.create({ workspace: file })).rejects.toThrow(/not a directory/);
  });

  it("restore returns the same instance", async () => {
    const provider = new LocalSandboxProvider();
    const sb = await provider.create({ workspace: tmp });
    const restored = await provider.restore(sb.id);
    expect(restored).toBe(sb);
  });
});
