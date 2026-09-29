import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { errorMessage, formatBytes, parseUploadArgs, prepareUploadFiles, shortSha256 } from "./upload.js";

describe("upload command", () => {
  describe("parseUploadArgs", () => {
    it("requires session id and at least one path", () => {
      const result = parseUploadArgs({ rest: [], flags: {}, json: false });
      expect(typeof result).toBe("string");
      expect(result).toMatch(/--thread <id> and at least one file path/);
    });

    it("parses session id and single file", () => {
      const result = parseUploadArgs({ rest: ["sess_abc", "file.txt"], flags: {}, json: false });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.sessionId).toBe("sess_abc");
        expect(result.paths).toEqual(["file.txt"]);
        expect(result.extract).toBe("auto");
        expect(result.overwrite).toBe(false);
        expect(result.message).toBeUndefined();
      }
    });

    it("parses multiple files", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file1.txt", "file2.pdf"],
        flags: {},
        json: false,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.paths).toEqual(["file1.txt", "file2.pdf"]);
      }
    });

    it("rejects --dest with multiple files", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file1.txt", "file2.txt"],
        flags: { dest: "/tmp/target" },
        json: false,
      });
      expect(typeof result).toBe("string");
      expect(result).toMatch(/--dest is only valid with exactly one file/);
    });

    it("accepts --dest with single file", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.txt"],
        flags: { dest: "/workspace/uploads/custom.txt" },
        json: false,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.dest).toBe("/workspace/uploads/custom.txt");
      }
    });

    it("parses --extract flag", () => {
      const autoResult = parseUploadArgs({
        rest: ["sess_abc", "file.zip"],
        flags: { extract: "auto" },
        json: false,
      });
      expect(typeof autoResult).not.toBe("string");
      if (typeof autoResult !== "string") {
        expect(autoResult.extract).toBe("auto");
      }

      const trueResult = parseUploadArgs({
        rest: ["sess_abc", "file.zip"],
        flags: { extract: "true" },
        json: false,
      });
      expect(typeof trueResult).not.toBe("string");
      if (typeof trueResult !== "string") {
        expect(trueResult.extract).toBe("true");
      }

      const falseResult = parseUploadArgs({
        rest: ["sess_abc", "file.zip"],
        flags: { extract: "false" },
        json: false,
      });
      expect(typeof falseResult).not.toBe("string");
      if (typeof falseResult !== "string") {
        expect(falseResult.extract).toBe("false");
      }
    });

    it("rejects invalid --extract value", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.zip"],
        flags: { extract: "invalid" },
        json: false,
      });
      expect(typeof result).toBe("string");
      expect(result).toMatch(/--extract must be auto, true, or false/);
    });

    it("parses --overwrite flag", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.txt"],
        flags: { overwrite: true },
        json: false,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.overwrite).toBe(true);
      }
    });

    it("parses --message flag", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.txt"],
        flags: { message: "summarize this" },
        json: false,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.message).toBe("summarize this");
      }
    });

    it("parses --json flag", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.txt"],
        flags: {},
        json: true,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.json).toBe(true);
      }
    });
  });

  describe("prepareUploadFiles", () => {
    it("threads --extract and --overwrite into every file info", async () => {
      const dir = await mkdtemp(join(tmpdir(), "valet-upload-"));
      const file = join(dir, "a.zip");
      await writeFile(file, "PK");

      const files = await prepareUploadFiles([file], undefined, "false", true);
      expect(files).toHaveLength(1);
      expect(files[0].extract).toBe("false");
      expect(files[0].overwrite).toBe(true);
    });

    it("defaults extract to auto and overwrite to false", async () => {
      const dir = await mkdtemp(join(tmpdir(), "valet-upload-"));
      const file = join(dir, "b.txt");
      await writeFile(file, "hi");

      const files = await prepareUploadFiles([file]);
      expect(files[0].extract).toBe("auto");
      expect(files[0].overwrite).toBe(false);
    });
  });

  describe("formatBytes", () => {
    it("formats bytes", () => {
      expect(formatBytes(512)).toBe("512 bytes");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(5120)).toBe("5 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
    });

    it("formats megabytes", () => {
      expect(formatBytes(5242880)).toBe("5 MB");
      expect(formatBytes(2621440)).toBe("2.5 MB");
    });
  });

  describe("errorMessage", () => {
    it("prefers the server corrective", () => {
      expect(errorMessage(409, { error: "File already exists", corrective: "Retry with overwrite=true." })).toBe(
        "Retry with overwrite=true.",
      );
    });

    it("falls back to the error field, then the status", () => {
      expect(errorMessage(422, { error: "bad zip" })).toBe("upload failed: bad zip");
      expect(errorMessage(500, "not json")).toBe("upload failed: HTTP 500");
      expect(errorMessage(500, undefined)).toBe("upload failed: HTTP 500");
    });
  });

  describe("shortSha256", () => {
    it("shortens sha256 with prefix", () => {
      expect(shortSha256("sha256:9f2c1a3b...")).toBe("9f2c1a3b");
    });

    it("shortens bare sha256", () => {
      expect(shortSha256("9f2c1a3b...")).toBe("9f2c1a3b");
    });
  });
});

describe("thread-addressed uploads", () => {
  it("parses explicit thread and legacy runtime flags without consuming a file path", () => {
    expect(parseUploadArgs(parseGlobalFlags(["--thread", "t1", "file.txt"]))).toMatchObject({ threadId: "t1", paths: ["file.txt"] });
    expect(parseUploadArgs(parseGlobalFlags(["--session", "s1", "file.txt"]))).toMatchObject({ sessionId: "s1", paths: ["file.txt"] });
    expect(typeof parseUploadArgs(parseGlobalFlags(["file.txt", "--thread"]))).toBe("string");
  });

  it("uploads to the resolved runtime and sends attachments to the requested thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "valet-thread-upload-"));
    const file = join(dir, "report.txt");
    await writeFile(file, "report");
    const { runUpload } = await import("./upload.js");
    const { vi } = await import("vitest");
    const uploadFiles = vi.fn().mockResolvedValue({ files: [{ path: "/workspace/uploads/report.txt", attachmentRef: "ref:report", bytes: 6, sha256: "sha256:12345678" }] });
    const sendPrompt = vi.fn().mockResolvedValue({ messageId: "message", threadId: "t1", activityAt: 1 });
    const stream = vi.fn(() => (async function* () {
      yield { seq: 1, ts: 1, type: "submission.settled" as const, sessionId: "s1", threadId: "t1", queueItemId: "message", outcome: "completed" as const };
    })());
    const code = await runUpload({ client: { getThread: async () => ({ sessionId: "s1" }), uploadFiles, sendPrompt }, stream, url: "http://x" }, { threadId: "t1", paths: [file], message: "Read this", json: true });
    expect(code).toBe(ExitCode.OK);
    expect(uploadFiles).toHaveBeenCalledWith("s1", expect.any(Array));
    expect(sendPrompt).toHaveBeenCalledWith("s1", { threadId: "t1", text: "Read this", fileRefs: [{ ref: "ref:report" }] });
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));
  });

  it("rejects conflicting runtime before uploading or sending", async () => {
    const { runUpload } = await import("./upload.js");
    const { vi } = await import("vitest");
    const uploadFiles = vi.fn();
    const sendPrompt = vi.fn();
    const code = await runUpload({ client: { getThread: async () => ({ sessionId: "other" }), uploadFiles, sendPrompt }, stream: () => (async function* () {})(), url: "http://x" }, { threadId: "t1", sessionId: "s1", paths: ["missing.txt"] });
    expect(code).toBe(ExitCode.Usage);
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
