# @valet/usage-audit

LLM usage audit tool for Valet. Pulls per-LLM-call attribution from D1,
categorizes session_threads as automation vs ad-hoc vs orchestrator,
and (optionally) classifies each thread's task type, cost driver, and
outcome via Anthropic.

Design spec: [`docs/specs/2026-06-17-llm-usage-audit-design.md`](../../docs/specs/2026-06-17-llm-usage-audit-design.md).

## Setup

1. Copy `.env.example` to `.env.local`.
2. Fill in `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `ANTHROPIC_API_KEY`, and
   the D1 database IDs you want to target.

## Usage

```bash
# Attribution only (no LLM calls), last 7 days against dev:
pnpm --filter @valet/usage-audit audit -- --env dev --skip-classify

# Full audit with classifier:
pnpm --filter @valet/usage-audit audit -- \
  --from 2026-06-10 --to 2026-06-17 \
  --env dev \
  --model haiku \
  --out ./out/2026-06-17

# Resume an interrupted run (skips threads already in classifications.jsonl):
pnpm --filter @valet/usage-audit audit -- --env dev --resume --out ./out/2026-06-17
```

## Outputs

In the directory passed to `--out` (default `./out/<from>-to-<to>`):

- `attribution.json` — full machine-readable aggregations.
- `classifications.jsonl` — one line per classified thread (append-only).
- `labels/{task_types,cost_drivers,outcomes}.json` — open-vocabulary
  label registries; new labels invented by the classifier get added here
  and re-fed into subsequent calls.
- `report.md` — human-readable report.

## Package boundaries

This package is designed to be lifted into the worker as an admin
route or scheduled job later. The CLI in `src/bin/audit.ts` is one
specific composition; the core (`runAudit`, `UsageDataSource`,
`LabelRegistry`, classifier client) takes everything as parameters so
nothing in `src/` reads `process.env` or assumes a CLI context.
