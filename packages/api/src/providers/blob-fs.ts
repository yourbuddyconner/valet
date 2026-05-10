import type { BlobStore } from "@valet/engine";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Filesystem-backed BlobStore. Keys are relative paths under `root`.
 * Absolute paths and `..` traversal are rejected. Content type is stored as a
 * sidecar file (`<key>.contentType`) so `get()` can return it.
 */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private resolveKey(key: string): string {
    if (isAbsolute(key) || key.includes("..") || key.startsWith("/")) {
      throw new Error(`FsBlobStore: invalid key ${key}`);
    }
    return resolve(this.root, key);
  }

  async put(
    key: string,
    data: Uint8Array | ReadableStream,
    opts?: { contentType?: string },
  ): Promise<void> {
    const target = this.resolveKey(key);
    await fs.mkdir(dirname(target), { recursive: true });
    if (data instanceof Uint8Array) {
      await fs.writeFile(target, data);
    } else {
      const reader = (data as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      await fs.writeFile(target, Buffer.concat(chunks));
    }
    if (opts?.contentType) {
      await fs.writeFile(target + ".contentType", opts.contentType);
    }
  }

  async get(key: string): Promise<{ data: ReadableStream; contentType?: string } | null> {
    const target = this.resolveKey(key);
    try {
      await fs.access(target);
    } catch {
      return null;
    }
    let contentType: string | undefined;
    try {
      contentType = await fs.readFile(target + ".contentType", "utf8");
    } catch {
      // No sidecar — leave contentType undefined.
    }
    const stream = Readable.toWeb(createReadStream(target)) as unknown as ReadableStream;
    return { data: stream, contentType };
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveKey(key);
    await fs.rm(target, { force: true });
    await fs.rm(target + ".contentType", { force: true });
  }
}
