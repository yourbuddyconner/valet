import type { BlobStore } from "../types.js";

export class InMemoryBlobStore implements BlobStore {
  private blobs = new Map<string, { data: Uint8Array; contentType?: string }>();

  async put(
    key: string,
    data: Uint8Array | ReadableStream,
    opts?: { contentType?: string },
  ): Promise<void> {
    if (data instanceof Uint8Array) {
      this.blobs.set(key, { data, contentType: opts?.contentType });
      return;
    }
    const reader = data.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.blobs.set(key, { data: merged, contentType: opts?.contentType });
  }

  async get(key: string): Promise<{ data: ReadableStream; contentType?: string } | null> {
    const blob = this.blobs.get(key);
    if (!blob) return null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(blob.data);
        controller.close();
      },
    });
    return { data: stream, contentType: blob.contentType };
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}
