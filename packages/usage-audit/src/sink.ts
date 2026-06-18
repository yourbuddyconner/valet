import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ClassificationLine, ClassificationSink } from './types.js';

export class FileClassificationSink implements ClassificationSink {
  constructor(private readonly path: string) {}

  async completedThreadIds(): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const raw = await readFile(this.path, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as ClassificationLine;
          if (parsed.threadId) out.add(parsed.threadId);
        } catch {
          // ignore malformed lines — at worst we'll re-classify one thread
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return out;
  }

  async append(line: ClassificationLine): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(line) + '\n');
  }
}
