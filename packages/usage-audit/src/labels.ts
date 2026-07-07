import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LABEL_DIMENSIONS } from './types.js';
import type { LabelDimension, LabelEntry, LabelRegistry } from './types.js';

export const SEED_LABELS: Record<LabelDimension, readonly string[]> = {
  taskType: [
    'debugging',
    'code-review',
    'feature-impl',
    'exploration',
    'ops-devops',
    'docs',
    'design-brainstorm',
    'data-analysis',
    'meta-orchestration',
    'trigger-handler',
    'other',
  ],
  costDriver: [
    'long-tool-loop',
    'large-context-reads',
    'many-small-turns',
    'planning-rumination',
    'tool-thrashing',
    'normal',
  ],
  outcome: ['completed', 'partial', 'abandoned', 'no-action-needed', 'unclear'],
};

// Lowercase, collapse whitespace, and convert spaces / underscores to dashes.
// Keeps the registry from accidentally splitting `flaky test` vs `flaky_test`
// vs `flaky-test` into three labels.
export function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

abstract class BaseLabelRegistry implements LabelRegistry {
  protected entries: Record<LabelDimension, Map<string, LabelEntry>>;

  constructor(seedFromConstants: boolean) {
    this.entries = {
      taskType: new Map(),
      costDriver: new Map(),
      outcome: new Map(),
    };
    if (seedFromConstants) {
      for (const dim of LABEL_DIMENSIONS) {
        for (const label of SEED_LABELS[dim]) {
          this.entries[dim].set(label, {
            label,
            firstSeenThreadId: '__seed__',
            firstSeenSummary: '',
            addedAt: new Date(0).toISOString(),
          });
        }
      }
    }
  }

  normalize(label: string): string {
    return normalizeLabel(label);
  }

  async list(dimension: LabelDimension): Promise<LabelEntry[]> {
    return Array.from(this.entries[dimension].values());
  }

  async add(
    dimension: LabelDimension,
    label: string,
    threadId: string,
    summary: string,
  ): Promise<{ added: boolean; normalized: string }> {
    const normalized = this.normalize(label);
    if (!normalized) return { added: false, normalized };
    if (this.entries[dimension].has(normalized)) {
      return { added: false, normalized };
    }
    this.entries[dimension].set(normalized, {
      label: normalized,
      firstSeenThreadId: threadId,
      firstSeenSummary: summary,
      addedAt: new Date().toISOString(),
    });
    await this.persist(dimension);
    return { added: true, normalized };
  }

  protected abstract persist(dimension: LabelDimension): Promise<void>;
}

export class MemoryLabelRegistry extends BaseLabelRegistry {
  constructor(opts: { seed?: boolean } = {}) {
    super(opts.seed ?? true);
  }

  protected async persist(): Promise<void> {
    // no-op
  }
}

export class FileLabelRegistry extends BaseLabelRegistry {
  private constructor(
    private readonly dir: string,
    seedNew: boolean,
  ) {
    super(seedNew);
  }

  // Loads (or initializes) registries from `<dir>/{task_types,cost_drivers,outcomes}.json`.
  static async load(dir: string): Promise<FileLabelRegistry> {
    await mkdir(dir, { recursive: true });
    const existing: Record<LabelDimension, LabelEntry[] | null> = {
      taskType: await readJson<LabelEntry[]>(join(dir, fileNameFor('taskType'))),
      costDriver: await readJson<LabelEntry[]>(join(dir, fileNameFor('costDriver'))),
      outcome: await readJson<LabelEntry[]>(join(dir, fileNameFor('outcome'))),
    };
    // Only seed dimensions we didn't load from disk; preserve user edits to
    // existing registry files across runs.
    const anyExisting = LABEL_DIMENSIONS.some((d) => existing[d] !== null);
    const reg = new FileLabelRegistry(dir, !anyExisting);
    for (const dim of LABEL_DIMENSIONS) {
      const loaded = existing[dim];
      if (loaded === null) continue;
      reg.entries[dim] = new Map(loaded.map((e) => [e.label, e]));
    }
    if (anyExisting) {
      // Top up with any new seed labels that aren't present yet (e.g. spec added
      // a new seed since the last run).
      for (const dim of LABEL_DIMENSIONS) {
        for (const label of SEED_LABELS[dim]) {
          if (!reg.entries[dim].has(label)) {
            reg.entries[dim].set(label, {
              label,
              firstSeenThreadId: '__seed__',
              firstSeenSummary: '',
              addedAt: new Date(0).toISOString(),
            });
          }
        }
      }
    }
    // Always persist after load so a fresh dir gets seeded files on disk.
    for (const dim of LABEL_DIMENSIONS) await reg.persist(dim);
    return reg;
  }

  protected async persist(dimension: LabelDimension): Promise<void> {
    const path = join(this.dir, fileNameFor(dimension));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(Array.from(this.entries[dimension].values()), null, 2));
  }
}

// Returns labels added during this run (i.e. anything that isn't a seed and
// wasn't loaded from disk before the run started). Useful for the report.
export function labelsIntroducedSince(
  registry: LabelRegistry,
  initial: Record<LabelDimension, Set<string>>,
): Promise<Record<LabelDimension, LabelEntry[]>> {
  return (async () => {
    const out = {} as Record<LabelDimension, LabelEntry[]>;
    for (const dim of LABEL_DIMENSIONS) {
      const all = await registry.list(dim);
      out[dim] = all.filter(
        (e) => !initial[dim].has(e.label) && e.firstSeenThreadId !== '__seed__',
      );
    }
    return out;
  })();
}

export async function snapshotLabels(
  registry: LabelRegistry,
): Promise<Record<LabelDimension, Set<string>>> {
  const out = {} as Record<LabelDimension, Set<string>>;
  for (const dim of LABEL_DIMENSIONS) {
    const all = await registry.list(dim);
    out[dim] = new Set(all.map((e) => e.label));
  }
  return out;
}

function fileNameFor(dim: LabelDimension): string {
  if (dim === 'taskType') return 'task_types.json';
  if (dim === 'costDriver') return 'cost_drivers.json';
  return 'outcomes.json';
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
