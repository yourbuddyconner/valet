# LLM Usage Audit — Design

**Date:** 2026-06-17
**Status:** Approved, ready for implementation plan
**Author:** Conner

## Problem

We hit our Anthropic API budget on Claude on Bedrock in dev. We need to
attribute that usage so we understand whether it came from automation
(orchestrator background work, trigger handlers) or from ad-hoc human
conversations, and within each bucket understand what kinds of work
drove the spend.

The existing `analytics_events` table already records every LLM call
with `model`, `input_tokens`, `output_tokens`, `session_id`, `user_id`,
`turn_id`, `tool_name`, and `created_at`. Attribution by category is a
SQL question. What's missing is a per-conversation understanding of
*what people were doing* — and that needs a classifier.

## Goal

A workspace package `@valet/usage-audit` that:

1. Pulls LLM-call attribution from D1 (via the Cloudflare REST API for
   the CLI use case) and rolls it up by category, user, model, and
   session_thread.
2. For every session_thread in the window, builds a compact digest of
   the conversation and asks an Anthropic model to classify task type,
   cost driver, and outcome. The label vocabulary is open: new labels
   the model invents get added to the registry and seen by subsequent
   classifications in the same run.
3. Emits a markdown report (human reading) and a JSON file (machine
   re-analysis), with intermediate `classifications.jsonl` for
   resumability.

The package is designed so its core can be reused inside the Worker
later (as an admin route or scheduled job) without rewriting — the data
source, classifier client, label registry, and output sink are all
interfaces.

## Non-goals

- No persistence of audit results back into D1 (one-off investigation
  tool; product version comes later).
- No worker route, admin UI, or auth integration. The CLI runs locally
  with a Cloudflare API token.
- No multi-org/multi-workspace scoping in the first cut. Dev has a
  small enough population that one report is fine.
- No cost-in-dollars math. Tokens are the unit; pricing changes by
  model/provider and is out of scope.

## Approach: two-stage pipeline

**Stage 1 — Attribution (SQL only).** No LLM calls. Cheap and complete.

**Stage 2 — Classification (LLM).** Per session_thread, one Anthropic
call against a compact digest, with structured output. Sequential or
mildly concurrent (cap ~10 in-flight).

The user can run Stage 1 alone via `--skip-classify` if the SQL
attribution is sufficient.

## Data model & queries

### Token attribution path

`analytics_events` rows with `event_type='llm_call'` carry tokens but
not `thread_id`. We bridge through `messages` on `(session_id, turn_id)`
to recover the thread.

Per `session_threads` row we produce:

- Identity: `session_id`, `thread_id`, `origin_type`,
  `origin_channel_type`, `origin_trigger_id`.
- Session context: `is_orchestrator`, `user_id`, `purpose`.
- Totals: `input_tokens`, `output_tokens`, `llm_call_count`,
  `tool_call_count`, `model_breakdown` (JSON map model→{calls, in, out}).
- Window markers: `first_call_at`, `last_call_at`.
- Tool histogram: `tool_name` → call count (from `analytics_events`
  rows with `tool_name IS NOT NULL`).

**Sanity check before trusting the join:** the script runs a small
diagnostic up front to measure the hit rate of joining
`analytics_events.turn_id` → `messages.turn_id`. If the hit rate is
low, it falls back to attributing tokens at the session level only
(threads under that session split the session totals proportionally
by message count) and surfaces a warning in the report's Methodology
section.

### Categories (mechanical, no classifier needed)

| Category | Rule |
|---|---|
| `automation-trigger` | `origin_trigger_id IS NOT NULL` |
| `orchestrator-chat` | `is_orchestrator=1` AND thread has any `role='user'` message AND no trigger |
| `orchestrator-internal` | `is_orchestrator=1` AND no user message AND no trigger |
| `ad-hoc` | everything else |

`session_threads.origin_channel_type` would seem to be the right signal for
chat-vs-internal, but in real data it's null on most channel-facing
orchestrator threads. The `EXISTS (... role='user')` test is the reliable
proxy: channel-bound conversations always start with an inbound user
message; orchestrator self-work (memory compaction, scheduled checks)
doesn't.

### Attribution outputs (SQL only)

1. Totals by category × model.
2. Totals by user × category.
3. Top 50 threads by input tokens, with first-message preview.
4. Daily burn-down by category (date × category × tokens).
5. Tool-call leaderboard (`tool_name` × calls × tokens).

## Classifier

### Per-thread digest

```
Thread metadata:
- category: orchestrator-chat | orchestrator-internal | ad-hoc | automation-trigger
- channel: slack | telegram | web | (none)
- duration: 14m, 23 LLM calls, 187k input / 12k output tokens
- top tools: edit (47), bash (31), read (28), grep (12)
- workflow/trigger: github-pr-opened from acme/api (if applicable)

First user message (truncated to 800 chars):
> ...

Last 2 assistant turns (truncated to 600 chars each):
> ...

Parent session title (if orchestrator-internal): ...
```

Cap of ~2-3k tokens per classifier input regardless of underlying
thread size. We are running this against potentially hundreds of
threads; bloated digests defeat the purpose.

### Open-vocabulary structured output

The classifier returns three label fields (`task_type`, `cost_driver`,
`outcome`) as open strings, plus `summary` and `confidence`. Each call
receives a "preferred labels" list in the prompt: prefer these; only
invent a new label when none fit.

**Seed labels:**

- `task_type`: debugging, code-review, feature-impl, exploration,
  ops-devops, docs, design-brainstorm, data-analysis,
  meta-orchestration, trigger-handler, other.
- `cost_driver`: long-tool-loop, large-context-reads, many-small-turns,
  planning-rumination, tool-thrashing, normal.
- `outcome`: completed, partial, abandoned, no-action-needed, unclear.

**Label registry:** three JSON files in the output directory
(`labels/task_types.json`, etc.). Each starts seeded above. After every
classification, any new label gets appended (with `thread_id` and
`summary` that introduced it). Next classification sees the updated
list. Labels are lowercased + kebab-case normalized before equality
checks so `debugging-tests` and `debugging_tests` collapse to the
same label.

### Model

Haiku 4.5 by default, `--model sonnet` flag to upgrade. Forced
tool-call to a `classify_thread` schema (structured output via
Anthropic SDK tool use).

### Rate limit handling

Normal exponential backoff on 429/5xx with jitter, capped retries.
Concurrency cap ~10 in-flight. No proactive throttling — the budget
has been raised.

## Package layout

```
packages/usage-audit/
├── package.json            # @valet/usage-audit
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts            # Public API exports
│   ├── types.ts            # Thread, Classification, Attribution, etc.
│   ├── data-source.ts      # interface UsageDataSource
│   ├── data-source-cf.ts   # CF REST API implementation
│   ├── queries.ts          # SQL strings
│   ├── categorize.ts       # Pure: thread metadata → category
│   ├── digest.ts           # Pure: (thread, messages) → digest string
│   ├── classifier.ts       # Anthropic client wrapper, schema, retries
│   ├── labels.ts           # interface LabelRegistry + file & memory impls
│   ├── attribution.ts      # SQL row aggregation into report shapes
│   ├── report.ts           # Pure: attribution + classifications → markdown
│   ├── runner.ts           # runAudit() — orchestrates a full run
│   └── bin/
│       └── audit.ts        # CLI entry, thin wrapper around runner
```

### Key boundaries

- `UsageDataSource` interface: CLI uses `CloudflareD1DataSource` (REST
  API). A future worker-internal version implements the same interface
  against the D1 binding.
- `LabelRegistry` interface: file-backed implementation for the CLI.
  Future product use can back it with a D1 table.
- `runner.runAudit(opts)` takes a `UsageDataSource`, a `LabelRegistry`,
  an Anthropic client, and a sink for writing classifications. CLI
  composes these; worker route would too.
- `classifier.ts` accepts an injected Anthropic client. CLI uses a
  top-level Anthropic API key; future product use can route through
  the user's configured LLM provider.
- Package depends only on `@valet/shared` and `@anthropic-ai/sdk`.
  **Does not import from `@valet/worker`.**

### Public API (`index.ts`)

```ts
export { runAudit } from './runner.js'
export type { UsageDataSource, LabelRegistry, AuditOptions, AuditResult } from './types.js'
export { CloudflareD1DataSource } from './data-source-cf.js'
export { FileLabelRegistry, MemoryLabelRegistry } from './labels.js'
export { categorizeThread } from './categorize.js'
export { buildThreadDigest } from './digest.js'
export { classifyThread } from './classifier.js'
export { generateReport } from './report.js'
```

### CLI

```bash
pnpm --filter @valet/usage-audit audit -- \
  --from 2026-06-10 --to 2026-06-17 \
  --env dev \
  --model haiku \
  --out ./out/2026-06-17 \
  --skip-classify \
  --resume
```

Output paths come from `--out`; the package itself has no opinions
about where files live.

### Secrets

`.env.local` in the package directory, for local CLI use only:

```
CF_API_TOKEN=...
CF_ACCOUNT_ID=...
ANTHROPIC_API_KEY=...
D1_DATABASE_ID_DEV=...
D1_DATABASE_ID_PROD=...
```

`bin/audit.ts` reads the env, validates, and passes config into
`runAudit()`. The package itself never reads `process.env` directly
— this is what keeps it usable from a worker later.

`--env prod` is required to target production; there is no default
environment.

## Output

### `report.md` (human-readable)

Sections, in order:

- **Headline.** Total tokens, top model, category mix in one paragraph.
- **By category.** Table of category × threads × calls × input × output × %.
- **By user.** Table of user × per-category totals × thread count.
- **By model.** Table of model × calls × input × output × avg-in-per-call.
- **Top 50 threads.** Table with category, user, first-message preview,
  calls, input tokens, top tools, task_type, cost_driver, outcome,
  summary.
- **Cost-driver analysis.** For each cost_driver label, top 5
  exemplar threads with a one-line explanation. The actionable section.
- **Daily burn-down.** Table or ASCII sparkline by day × category.
- **Tool-call leaderboard.** Table of tool × calls × tokens × share.
- **Labels introduced this run.** Per dimension, new labels with the
  thread that introduced them. Surfaces where seed labels were
  insufficient and flags candidates for dedup.
- **Methodology.** Category rules, token→thread bridging hit rate
  (and any fallback), classifier model, classifier prompt version,
  date range. Enough to reproduce the report.

Empty sections are omitted.

### `attribution.json` (machine-readable)

```ts
{
  meta: { from, to, env, generatedAt, classifierModel, totalThreads, totalLlmCalls },
  totals: { inputTokens, outputTokens, byCategory: {...}, byModel: {...} },
  byUser: [{ userId, email, totals, byCategory }],
  byModel: [{ model, calls, input, output }],
  topThreads: [{ threadId, sessionId, category, userId, totals, topTools, classification? }],
  daily: [{ date, byCategory: {...} }],
  toolLeaderboard: [{ toolName, calls, inputTokens, share }],
  labelsIntroduced: { taskTypes: [...], costDrivers: [...], outcomes: [...] },
}
```

### `classifications.jsonl` (intermediate, resumability)

One line per thread, append-only:

```ts
{
  threadId, sessionId, category, classifiedAt, model,
  input: { digest: "..." },
  output: { task_type, cost_driver, outcome, summary, confidence }
}
```

`--resume` reads existing lines and skips threads already present.
Storing the digest in each line allows re-classification with a
different model later without re-querying D1.

## Risks & open questions

- **`turn_id` join hit rate.** If `analytics_events.turn_id` doesn't
  populate reliably or doesn't always match `messages.turn_id`, the
  thread-level attribution degrades to session-level proportional
  splits. The diagnostic at the start of the run surfaces this; if
  the hit rate is below ~80% we should call it out in the report.
- **D1 REST API pagination.** Large result sets are chunked with
  `LIMIT/OFFSET` and explicit `ORDER BY id`. If a query exceeds the
  CF row-limit-per-response, we paginate transparently.
- **Label sprawl.** Open vocabulary risks `debugging-flaky-test` vs
  `debug-flaky-tests` vs `flaky-test-debug` as three labels. Kebab
  normalization plus a "prefer existing" hint in the prompt is the
  first line of defense; the "Labels introduced" section in the
  report makes manual dedup easy after the run.
- **Classifier accuracy on orchestrator-internal threads.** Background
  work like memory compaction has very little conversational content
  to classify. The digest includes session-level context for these
  cases; we'll see how this works in the first run and adjust the
  digest builder if needed.

## Future product evolution (informational)

Path from CLI to product feature:

1. Implement `D1DataSource` (binding-backed) — mirror of
   `CloudflareD1DataSource` minus the REST hop.
2. Implement a D1-backed `LabelRegistry` (small new table:
   `audit_labels { dimension, label, first_seen_at, sample_thread_id }`).
3. Add an admin route `/api/admin/usage-audit` that runs `runAudit()`
   inside a Workflow (long-running, needs durable execution for the
   classifier loop).
4. Persist `Attribution` and `Classification` rows to D1 instead of
   files; render the report in the admin UI.

The package boundaries above are the contract that makes this drop-in.
