/**
 * `valet upload --thread <thread-id> <path...> [--dest <path>] [--extract auto|true|false]
 *   [--overwrite] [--message "..."]`
 *
 * Uploads one or more files to a session's sandbox at `/workspace/uploads/`.
 * Each file is uploaded as a separate multipart request. On success, returns
 * the attachment ref for each file. If `--message` is set, posts a follow-up
 * message with the refs spliced into its attachments and streams the reply.
 *
 * The core logic is testable: `runUpload` is pure over `(deps, flags)`, with
 * a stub client and fixture file paths. The stream wiring (WS consumption,
 * exit-code mapping) reuses the `send` command's patterns.
 */
import * as fs from "fs";
import * as path from "path";
import { formatBytes } from "@valet/shared";
import { InstanceClient } from "../client.js";
import { ApiError, ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printLine, type ParsedFlags } from "../output.js";
import { resolveInstance } from "../resolve.js";
import { streamSession, type StreamSessionOpts } from "../stream.js";
import type { CliContext } from "../types.js";
import type {
  PostSessionFileUploadResponse,
  SendPromptRequest,
  SendPromptResponse,
  WireEvent,
} from "../../wire/types.js";
import { consumeSend } from "./send.js";

/** The subset of `InstanceClient` the `upload` command needs. */
export interface UploadClient {
  getThread(id: string): Promise<{ sessionId: string }>;
  uploadFiles(sessionId: string, files: UploadFileInfo[]): Promise<UploadResponse>;
  sendPrompt(id: string, body: SendPromptRequest): Promise<SendPromptResponse>;
}

/** Info about one file to upload. */
export interface UploadFileInfo {
  sourcePath: string;
  dest?: string;
  extract?: "auto" | "true" | "false";
  overwrite?: boolean;
}

/**
 * Response for one uploaded file — the wire contract, not a copy of it, so
 * a server-side shape change is a compile error here.
 */
export type UploadedFile = PostSessionFileUploadResponse;

/** Full response from uploading files to a session. */
export interface UploadResponse {
  files: UploadedFile[];
}

/** The WS stream factory — the real `streamSession`, or a stub in tests. */
export type StreamFn = (opts: StreamSessionOpts) => AsyncIterable<WireEvent>;

export interface UploadDeps {
  client: UploadClient;
  stream: StreamFn;
  url: string;
  apiKey?: string;
}

/** Parse CLI args and validate the upload command invocation. */
export interface UploadArgs {
  sessionId?: string;
  threadId?: string;
  paths: string[];
  dest?: string;
  extract?: "auto" | "true" | "false";
  overwrite?: boolean;
  message?: string;
  json?: boolean;
}

/**
 * Parse the raw CLI args into a typed UploadArgs. Validates:
 * - At least one path is provided.
 * - `--dest` is only valid with exactly one path.
 * - `--extract` is one of the allowed values.
 */
export function parseUploadArgs(flags: ParsedFlags): UploadArgs | string {
  const threadId = typeof flags.flags.thread === "string" ? flags.flags.thread : undefined;
  const sessionFlag = typeof flags.flags.session === "string" ? flags.flags.session : undefined;
  if (flags.flags.thread === true || flags.flags.session === true || flags.flags.thread === "" || flags.flags.session === "") {
    return "valet upload: provide an id after --thread or --session";
  }
  // Positional runtime IDs remain compatible with existing scripts.
  const explicitTarget = threadId !== undefined || sessionFlag !== undefined;
  const sessionId = sessionFlag ?? (explicitTarget ? undefined : flags.rest[0]);
  const filePaths = explicitTarget ? flags.rest : flags.rest.slice(1);
  if ((!threadId && !sessionId) || filePaths.length === 0) {
    return "valet upload: provide --thread <id> and at least one file path. Legacy scripts can provide a session id first.";
  }

  const dest = typeof flags.flags.dest === "string" ? flags.flags.dest : undefined;
  if (dest !== undefined && filePaths.length > 1) {
    return "--dest is only valid with exactly one file";
  }

  let extract: "auto" | "true" | "false" | undefined = "auto";
  if (flags.flags.extract !== undefined) {
    const val = String(flags.flags.extract).toLowerCase();
    if (val === "auto" || val === "true" || val === "false") {
      extract = val as "auto" | "true" | "false";
    } else {
      return `--extract must be auto, true, or false (got: ${flags.flags.extract})`;
    }
  }

  return {
    sessionId,
    threadId,
    paths: filePaths,
    dest,
    extract,
    overwrite: flags.flags.overwrite === true,
    message: typeof flags.flags.message === "string" ? flags.flags.message : undefined,
    json: flags.json,
  };
}

/**
 * Resolve file paths from CLI args (relative to cwd) and read their metadata.
 * Returns file info suitable for the upload request. On error, throws with
 * a user-facing message.
 */
export async function prepareUploadFiles(
  paths: string[],
  dest?: string,
  extract?: "auto" | "true" | "false",
  overwrite?: boolean,
): Promise<UploadFileInfo[]> {
  const files: UploadFileInfo[] = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${p}: ${msg}`);
    }
    if (!stat.isFile()) {
      throw new Error(`${p} is not a file. Pass a regular file path, not a directory.`);
    }
    files.push({
      sourcePath: abs,
      dest: paths.length === 1 ? dest : undefined,
      extract: extract ?? "auto",
      overwrite: overwrite ?? false,
    });
  }
  return files;
}

// One formatter for every surface that prints a file size (see
// packages/shared); re-exported for this command's tests.
export { formatBytes };

/**
 * Format a short sha256 suffix (first 8 chars after "sha256:"). For display
 * only, not verification.
 */
export function shortSha256(full: string): string {
  if (full.startsWith("sha256:")) return full.slice(7, 15);
  return full.slice(0, 8);
}

/**
 * Print the result of one successful upload to stdout.
 */
export function printUploadResult(file: UploadedFile): void {
  const sha = shortSha256(file.sha256);
  printLine(`  ${path.basename(file.path)} → ${file.path} (${formatBytes(file.bytes)}, sha256:${sha})`);
  if (file.extracted && file.extractedTo) {
    // The extract root is server-computed (`extractedTo`); printing it
    // verbatim keeps the CLI correct when the server's naming rule changes.
    printLine(`    extracted ${file.extracted.length} file${file.extracted.length === 1 ? "" : "s"} to ${file.extractedTo}`);
  }
}

/**
 * Map error response to a user-facing message. Prioritizes the server's
 * `corrective` field when present.
 */
export function errorMessage(status: number, body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return `upload failed: HTTP ${status}`;
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.corrective === "string") return obj.corrective;
  if (typeof obj.error === "string") return `upload failed: ${obj.error}`;
  return `upload failed: HTTP ${status}`;
}

/**
 * Core upload logic: prepare files, stream each to the server as multipart,
 * collect refs, and optionally send a follow-up message with them.
 *
 * Exit codes:
 * - 0 on success
 * - 1 on upload failure or network error
 * - 3 if follow-up message blocks on a decision gate (like `valet send`)
 */
export async function runUpload(deps: UploadDeps, args: UploadArgs): Promise<number> {
  let uploadedFiles: UploadedFile[] = [];
  let sessionId = args.sessionId;

  try {
    if (args.threadId) {
      const thread = await deps.client.getThread(args.threadId);
      if (sessionId !== undefined && sessionId !== thread.sessionId) {
        printErr("The thread does not belong to the specified runtime. Use its runtime or omit --session.");
        return ExitCode.Usage;
      }
      sessionId = thread.sessionId;
    }
    if (!sessionId) {
      printErr("valet upload: provide --thread <id> or --session <id>.");
      return ExitCode.Usage;
    }
    // Prepare file metadata from paths, carrying the parsed flags through.
    const fileInfos = await prepareUploadFiles(args.paths, args.dest, args.extract, args.overwrite);

    // Upload each file.
    if (!args.json && fileInfos.length > 0) {
      printLine(`uploading ${fileInfos.length} file${fileInfos.length === 1 ? "" : "s"}…`);
    }
    const response = await deps.client.uploadFiles(sessionId, fileInfos);
    uploadedFiles = response.files;

    if (!args.json) {
      for (const file of uploadedFiles) {
        printUploadResult(file);
      }
      if (uploadedFiles.length > 0) {
        printLine("");
      }
    }
  } catch (err) {
    if (err instanceof ApiError) {
      // Surface the server's corrective (errorMessage prefers it) instead
      // of the generic "API request failed with status N".
      let body: unknown;
      try {
        body = JSON.parse(err.body);
      } catch {
        body = undefined;
      }
      printErr(`valet upload: ${errorMessage(err.status, body)}`);
      return ExitCode.TurnError;
    }
    const message = err instanceof Error ? err.message : String(err);
    printErr(`valet upload: ${message}`);
    return ExitCode.TurnError;
  }

  // If `--message` was set, send a follow-up with the uploaded refs.
  if (args.message !== undefined && uploadedFiles.length > 0) {
    const fileRefs = uploadedFiles.map((f) => ({
      ref: f.attachmentRef,
    }));
    try {
      const sent = await deps.client.sendPrompt(sessionId, {
        threadId: args.threadId,
        text: args.message,
        fileRefs,
      });

      if (sent.messageId === null) {
        if (!args.json) {
          printLine(`command executed on thread ${sent.threadId}`);
        }
        return ExitCode.OK;
      }

      // Stream the reply using the same logic as `valet send`.
      return await consumeSend(deps, {
        sessionId,
        messageId: sent.messageId,
        threadId: sent.threadId,
        json: args.json ?? false,
      });
    } catch (err) {
      printErr(`valet upload: failed to send message: ${err instanceof Error ? err.message : String(err)}`);
      return ExitCode.TurnError;
    }
  }

  return ExitCode.OK;
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const parsed = parseUploadArgs(flags);
  if (typeof parsed === "string") {
    printErr(parsed);
    return ExitCode.Usage;
  }

  const instance = resolveInstance({
    flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined,
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });

  // The upload command is a thin wrapper that:
  // 1. Extends InstanceClient to add uploadFiles (done via RealUploadClient below)
  // 2. Calls runUpload with the deps
  const client = new RealUploadClient({ url: instance.url, apiKey: instance.apiKey });
  return runUpload({ client, stream: streamSession, url: instance.url, apiKey: instance.apiKey }, parsed);
}

/**
 * Wrapper that delegates to InstanceClient and implements the UploadClient interface.
 */
class RealUploadClient implements UploadClient {
  private readonly instanceClient: InstanceClient;

  constructor(opts: { url: string; apiKey?: string }) {
    this.instanceClient = new InstanceClient(opts);
  }

  getThread(id: string): Promise<{ sessionId: string }> {
    return this.instanceClient.getThread(id);
  }

  async uploadFiles(sessionId: string, files: UploadFileInfo[]): Promise<UploadResponse> {
    const uploadedFiles: UploadedFile[] = [];

    for (const fileInfo of files) {
      uploadedFiles.push(
        await this.instanceClient.uploadFile(
          sessionId,
          fileInfo.sourcePath,
          fileInfo.dest,
          fileInfo.extract,
          fileInfo.overwrite,
        ),
      );
    }

    return { files: uploadedFiles };
  }

  async sendPrompt(id: string, body: SendPromptRequest): Promise<SendPromptResponse> {
    return this.instanceClient.sendPrompt(id, body);
  }
}
