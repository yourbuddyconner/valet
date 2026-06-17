import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAttribution } from './attribution.js';
import { categorizeThread } from './categorize.js';
import { buildThreadDigest } from './digest.js';
import { labelsIntroducedSince, snapshotLabels } from './labels.js';
import { generateReport } from './report.js';
import { LABEL_DIMENSIONS } from './types.js';
import type {
  AuditOptions,
  AuditResult,
  CategorizedThread,
  Classification,
  ClassificationLine,
  LabelDimension,
  MessageRow,
  SessionRow,
  ThreadRow,
} from './types.js';

const PREVIEW_LEN = 200;

export async function runAudit(opts: AuditOptions): Promise<AuditResult> {
  const log = opts.logger ?? noopLogger;

  log(`window: ${opts.from.toISOString()} → ${opts.to.toISOString()} (${opts.env})`);

  // 1. Diagnostic.
  const diagnostic = await opts.dataSource.diagnostic(opts.from, opts.to);
  log(
    `join diagnostic: ${diagnostic.joinedToMessage}/${diagnostic.llmCallRows} = ` +
      `${(diagnostic.hitRate * 100).toFixed(1)}% hit rate`,
  );

  // 2. Thread totals.
  const totals = await opts.dataSource.fetchThreadTotals(opts.from, opts.to);
  log(`fetched totals for ${totals.size} thread buckets`);

  // 3. Resolve thread metadata for real (non-unattributed) buckets.
  const realThreadIds = Array.from(totals.keys()).filter(
    (id) => !id.startsWith('__unattributed__:'),
  );
  const threadRows = await opts.dataSource.fetchThreads(realThreadIds);
  const threadsById = new Map(threadRows.map((t) => [t.threadId, t]));
  log(`resolved ${threadsById.size} threads (${realThreadIds.length - threadsById.size} stale)`);

  // 4. Resolve users (for emails in report).
  const userIds = Array.from(new Set(threadRows.map((t) => t.userId)));
  const users = await opts.dataSource.fetchUsers(userIds);

  // 5. Classification loop (skipped if no classifier).
  const classifications = new Map<string, Classification>();
  let classificationCount = 0;
  const initialLabels = await snapshotLabels(opts.labels);

  if (opts.classifier) {
    const completed = opts.resume ? await opts.classificationSink.completedThreadIds() : new Set<string>();
    log(`${completed.size} threads already classified (resume); ${threadsById.size - completed.size} to go`);

    // Categorize once up front so we know what to classify.
    const queue: CategorizedThread[] = [];
    for (const thread of threadsById.values()) {
      const t = totals.get(thread.threadId);
      if (!t) continue;
      if (completed.has(thread.threadId)) continue;
      queue.push({ thread, totals: t, category: categorizeThread(thread) });
    }

    await runWithConcurrency(queue, opts.concurrency, async (item, index) => {
      const messages = await opts.dataSource.fetchThreadMessages(item.thread.threadId);
      let parentSessionTitle: string | null = null;
      if (item.category === 'orchestrator-internal') {
        const session = await safeFetchSession(opts.dataSource, item.thread.sessionId);
        parentSessionTitle = session?.title ?? null;
      }
      const digest = buildThreadDigest({
        thread: item.thread,
        totals: item.totals,
        category: item.category,
        messages,
        parentSessionTitle,
      });

      const preferred = await currentPreferredLabels(opts);
      const classification = await opts.classifier!({
        digest,
        preferredLabels: preferred,
        model: opts.model,
      });

      // Normalize labels via the registry — this also adds new labels.
      const normalized: Classification = {
        ...classification,
        taskType: (
          await opts.labels.add('taskType', classification.taskType, item.thread.threadId, classification.summary)
        ).normalized,
        costDriver: (
          await opts.labels.add('costDriver', classification.costDriver, item.thread.threadId, classification.summary)
        ).normalized,
        outcome: (
          await opts.labels.add('outcome', classification.outcome, item.thread.threadId, classification.summary)
        ).normalized,
      };

      classifications.set(item.thread.threadId, normalized);
      const line: ClassificationLine = {
        threadId: item.thread.threadId,
        sessionId: item.thread.sessionId,
        category: item.category,
        classifiedAt: new Date().toISOString(),
        model: opts.model,
        input: { digest },
        output: normalized,
      };
      await opts.classificationSink.append(line);
      classificationCount += 1;
      if ((index + 1) % 10 === 0) {
        log(`classified ${index + 1}/${queue.length}`);
      }
    });

    // Reload from sink in case we resumed — anything already classified
    // should still show up in the report.
    if (opts.resume) {
      // We don't have a read API; classifications-only-since-now is enough.
      // The report's topThreads section will show classification=null for
      // any thread present in the prior run but not in this session's cache.
      // For now we'll re-read the file to merge.
      // (Optimization: rely on sink to provide a `read all` method later.)
    }
  } else {
    log('classifier skipped (--skip-classify)');
  }

  // 6. Build attribution. We need first messages for top threads — fetch
  // them now, after classification narrows which threads we care about.
  const generatedAt = new Date();
  const attribution = buildAttribution({
    from: opts.from,
    to: opts.to,
    env: opts.env,
    generatedAt,
    classifierModel: opts.classifier ? opts.model : null,
    diagnostic,
    threads: threadsById,
    totals,
    users,
    classifications,
  });

  // 7. First message previews for top threads.
  const threadFirstMessages = new Map<string, string>();
  const topThreadIds = attribution.topThreads.map((t) => t.threadId);
  for (const id of topThreadIds) {
    const msgs = await opts.dataSource.fetchThreadMessages(id);
    const firstUser = msgs.find((m: MessageRow) => m.role === 'user');
    threadFirstMessages.set(id, firstUser ? firstUser.content : '');
  }

  // 8. Labels introduced this run.
  const labelsIntroduced = await labelsIntroducedSince(opts.labels, initialLabels);

  // 9. Generate report and write outputs.
  await mkdir(opts.outDir, { recursive: true });
  const attributionPath = join(opts.outDir, 'attribution.json');
  const reportPath = join(opts.outDir, 'report.md');
  const classificationsPath = join(opts.outDir, 'classifications.jsonl');

  await writeFile(attributionPath, JSON.stringify(attribution, null, 2));
  const report = generateReport({ attribution, labelsIntroduced, threadFirstMessages });
  await writeFile(reportPath, report);

  log(`wrote ${attributionPath}`);
  log(`wrote ${reportPath}`);

  return {
    attribution,
    classificationCount,
    diagnostic,
    labelsIntroduced,
    reportPath,
    attributionPath,
    classificationsPath,
  };
}

async function currentPreferredLabels(opts: AuditOptions): Promise<Record<LabelDimension, string[]>> {
  const out = {} as Record<LabelDimension, string[]>;
  for (const dim of LABEL_DIMENSIONS) {
    const entries = await opts.labels.list(dim);
    out[dim] = entries.map((e) => e.label);
  }
  return out;
}

async function safeFetchSession(
  ds: { fetchSession: (id: string) => Promise<SessionRow | null> },
  id: string,
): Promise<SessionRow | null> {
  try {
    return await ds.fetchSession(id);
  } catch {
    return null;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      try {
        await worker(items[idx]!, idx);
      } catch (err) {
        errors.push(err);
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, concurrency) }, () => run());
  await Promise.all(workers);
  if (errors.length > 0) {
    // Don't abort the whole run on a single thread failure — surface count.
    // The CLI will print details from stderr if we logged them.
    // First error rethrown so the caller can decide.
    throw new Error(
      `${errors.length} classifier error(s); first: ${(errors[0] as Error)?.message ?? errors[0]}`,
    );
  }
}

function noopLogger() {
  /* no-op */
}

// Truncate helper exposed for tests
export function previewText(s: string, len = PREVIEW_LEN): string {
  if (s.length <= len) return s;
  return `${s.slice(0, len - 1)}…`;
}
