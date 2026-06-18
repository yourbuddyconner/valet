#!/usr/bin/env bun
import Anthropic from '@anthropic-ai/sdk';
import { join } from 'node:path';
import { CloudflareD1DataSource } from '../data-source-cf.js';
import { createClassifier } from '../classifier.js';
import { FileLabelRegistry } from '../labels.js';
import { runAudit } from '../runner.js';
import { FileClassificationSink } from '../sink.js';

interface CliArgs {
  from: Date;
  to: Date;
  env: 'dev' | 'prod';
  model: 'haiku' | 'sonnet';
  outDir: string;
  skipClassify: boolean;
  resume: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    return argv[i + 1];
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const envArg = get('--env');
  if (envArg !== 'dev' && envArg !== 'prod') {
    throw new Error(`--env must be 'dev' or 'prod' (got: ${envArg ?? 'missing'})`);
  }

  const modelArg = (get('--model') ?? 'haiku') as 'haiku' | 'sonnet';
  if (modelArg !== 'haiku' && modelArg !== 'sonnet') {
    throw new Error(`--model must be 'haiku' or 'sonnet' (got: ${modelArg})`);
  }

  // Default window: last 7 days.
  const to = parseDate(get('--to')) ?? new Date();
  const fromArg = get('--from');
  const from = fromArg ? parseDate(fromArg)! : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('--from / --to must be parseable as ISO dates (e.g. 2026-06-10)');
  }
  if (from >= to) {
    throw new Error(`--from (${from.toISOString()}) must be before --to (${to.toISOString()})`);
  }

  const outDirArg = get('--out');
  const outDir =
    outDirArg ?? join(process.cwd(), 'out', `${envArg}-${dateOnly(from)}-to-${dateOnly(to)}`);

  const concurrencyArg = get('--concurrency');
  const concurrency = concurrencyArg ? Number.parseInt(concurrencyArg, 10) : 10;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer (got: ${concurrencyArg})`);
  }

  return {
    from,
    to,
    env: envArg,
    model: modelArg,
    outDir,
    skipClassify: has('--skip-classify'),
    resume: has('--resume'),
    concurrency,
  };
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const apiToken = requireEnv('CF_API_TOKEN');
  const accountId = requireEnv('CF_ACCOUNT_ID');
  const dbId = requireEnv(args.env === 'dev' ? 'D1_DATABASE_ID_DEV' : 'D1_DATABASE_ID_PROD');

  const dataSource = new CloudflareD1DataSource({ apiToken, accountId, databaseId: dbId });
  const labels = await FileLabelRegistry.load(join(args.outDir, 'labels'));
  const sink = new FileClassificationSink(join(args.outDir, 'classifications.jsonl'));

  let classifier;
  if (!args.skipClassify) {
    const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
    const client = new Anthropic({ apiKey: anthropicKey });
    classifier = createClassifier({ client });
  }

  const logger = (msg: string) => {
    // eslint-disable-next-line no-console
    console.log(`[audit] ${msg}`);
  };

  logger(`outDir: ${args.outDir}`);

  const result = await runAudit({
    from: args.from,
    to: args.to,
    env: args.env,
    dataSource,
    labels,
    classifier,
    classificationSink: sink,
    model: args.model,
    outDir: args.outDir,
    resume: args.resume,
    concurrency: args.concurrency,
    logger,
  });

  logger(`done — classified ${result.classificationCount} threads`);
  logger(`report: ${result.reportPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[audit] ERROR:', err);
  process.exit(1);
});
