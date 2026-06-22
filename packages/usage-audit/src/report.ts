import { CATEGORIES, LABEL_DIMENSIONS } from './types.js';
import type {
  Attribution,
  Category,
  LabelDimension,
  LabelEntry,
} from './types.js';

export interface ReportInput {
  attribution: Attribution;
  labelsIntroduced: Record<LabelDimension, LabelEntry[]>;
  threadFirstMessages: Map<string, string>; // threadId → first message preview
}

export function generateReport(input: ReportInput): string {
  const { attribution: a, labelsIntroduced, threadFirstMessages } = input;
  const out: string[] = [];

  out.push(`# LLM Usage Audit — ${dateOnly(a.meta.from)} to ${dateOnly(a.meta.to)} (${a.meta.env})`);
  out.push('');

  // Headline
  out.push('## Headline');
  out.push('');
  out.push(
    `- Total: **${fmt(a.totals.inputTokens)}** input tokens, ` +
      `**${fmt(a.totals.outputTokens)}** output across ` +
      `**${a.meta.totalLlmCalls.toLocaleString()}** LLM calls, ` +
      `**${a.meta.totalThreads.toLocaleString()}** threads.`,
  );
  const topModel = a.byModel[0];
  if (topModel) {
    const pct =
      a.totals.inputTokens === 0
        ? 0
        : Math.round((topModel.inputTokens / a.totals.inputTokens) * 100);
    out.push(`- Top model: **${topModel.model}** (${pct}% of input tokens).`);
  }
  const mix = categoryMixSentence(a);
  if (mix) out.push(`- Burn shape: ${mix}.`);
  if (a.totals.unattributed.inputTokens > 0) {
    const pct =
      a.totals.inputTokens === 0
        ? 0
        : Math.round((a.totals.unattributed.inputTokens / a.totals.inputTokens) * 100);
    out.push(
      `- Unattributed: ${fmt(a.totals.unattributed.inputTokens)} input (${pct}%) couldn't be ` +
        `bridged to a thread (join hit rate ${formatPercent(a.meta.joinHitRate)}).`,
    );
  }
  out.push('');

  // By category
  out.push('## By category');
  out.push('');
  out.push('| Category | Threads | LLM calls | Input tokens | Output tokens | % of input |');
  out.push('|---|---:|---:|---:|---:|---:|');
  for (const c of CATEGORIES) {
    const v = a.totals.byCategory[c];
    const pct = a.totals.inputTokens === 0 ? 0 : (v.inputTokens / a.totals.inputTokens) * 100;
    out.push(
      `| ${c} | ${v.threads} | ${v.llmCalls.toLocaleString()} | ${fmt(v.inputTokens)} | ${fmt(v.outputTokens)} | ${pct.toFixed(1)}% |`,
    );
  }
  if (a.totals.unattributed.inputTokens > 0) {
    const v = a.totals.unattributed;
    const pct = a.totals.inputTokens === 0 ? 0 : (v.inputTokens / a.totals.inputTokens) * 100;
    out.push(
      `| _unattributed_ | — | ${v.llmCalls.toLocaleString()} | ${fmt(v.inputTokens)} | ${fmt(v.outputTokens)} | ${pct.toFixed(1)}% |`,
    );
  }
  out.push('');

  // By user
  if (a.byUser.length > 0) {
    out.push('## By user');
    out.push('');
    out.push(
      '| User | Threads | Total input | Total output | Orchestrator-chat | Orchestrator-internal | Automation | Ad-hoc |',
    );
    out.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const u of a.byUser) {
      out.push(
        `| ${escapeMd(u.email ?? u.userId)} | ${u.threadCount} | ` +
          `${fmt(u.totalInputTokens)} | ${fmt(u.totalOutputTokens)} | ` +
          `${fmt(u.byCategory['orchestrator-chat'].inputTokens)} | ` +
          `${fmt(u.byCategory['orchestrator-internal'].inputTokens)} | ` +
          `${fmt(u.byCategory['automation-trigger'].inputTokens)} | ` +
          `${fmt(u.byCategory['ad-hoc'].inputTokens)} |`,
      );
    }
    out.push('');
  }

  // By model
  if (a.byModel.length > 0) {
    out.push('## By model');
    out.push('');
    out.push('| Model | Calls | Input tokens | Output tokens | Avg in/call |');
    out.push('|---|---:|---:|---:|---:|');
    for (const m of a.byModel) {
      out.push(
        `| ${escapeMd(m.model)} | ${m.calls.toLocaleString()} | ${fmt(m.inputTokens)} | ${fmt(m.outputTokens)} | ${m.avgInputPerCall.toLocaleString()} |`,
      );
    }
    out.push('');
  }

  // Top threads
  if (a.topThreads.length > 0) {
    out.push(`## Top ${a.topThreads.length} threads`);
    out.push('');
    out.push(
      '| # | Category | User | First message | Calls | Input | Top tools | Task type | Cost driver | Outcome | Summary |',
    );
    out.push('|---:|---|---|---|---:|---:|---|---|---|---|---|');
    for (const t of a.topThreads) {
      const preview = threadFirstMessages.get(t.threadId) ?? t.firstMessagePreview;
      const topTools = t.topTools.map((x) => `${x.toolName}(${x.calls})`).join(', ');
      const c = t.classification;
      out.push(
        `| ${t.rank} | ${t.category} | ${escapeMd(t.userEmail ?? t.userId)} | ` +
          `${escapeMd(truncate(preview, 60))} | ${t.llmCalls} | ${fmt(t.inputTokens)} | ` +
          `${escapeMd(topTools)} | ${c?.taskType ?? '—'} | ${c?.costDriver ?? '—'} | ` +
          `${c?.outcome ?? '—'} | ${escapeMd(truncate(c?.summary ?? '', 80))} |`,
      );
    }
    out.push('');
  }

  // Cost-driver analysis
  const classifiedThreads = a.topThreads.filter((t) => t.classification);
  if (classifiedThreads.length > 0) {
    out.push('## Cost-driver analysis');
    out.push('');
    const driversByName = new Map<string, typeof classifiedThreads>();
    for (const t of classifiedThreads) {
      const d = t.classification!.costDriver;
      const list = driversByName.get(d) ?? [];
      list.push(t);
      driversByName.set(d, list);
    }
    const sortedDrivers = Array.from(driversByName.entries())
      .map(([name, threads]) => ({
        name,
        threads,
        totalInput: threads.reduce((s, t) => s + t.inputTokens, 0),
      }))
      .sort((a, b) => b.totalInput - a.totalInput);

    for (const d of sortedDrivers) {
      out.push(`### ${d.name} — ${fmt(d.totalInput)} input tokens across ${d.threads.length} threads`);
      out.push('');
      const top = d.threads
        .slice()
        .sort((a, b) => b.inputTokens - a.inputTokens)
        .slice(0, 5);
      for (const t of top) {
        out.push(
          `- **${fmt(t.inputTokens)}** — ${t.category}, ${escapeMd(t.userEmail ?? t.userId)}: ${escapeMd(t.classification!.summary)}`,
        );
      }
      out.push('');
    }
  }

  // Daily burn-down
  if (a.daily.length > 0) {
    out.push('## Daily burn-down');
    out.push('');
    out.push(
      '| Date | orchestrator-chat | orchestrator-internal | automation-trigger | ad-hoc | Total |',
    );
    out.push('|---|---:|---:|---:|---:|---:|');
    for (const d of a.daily) {
      const oc = d.byCategory['orchestrator-chat'].inputTokens;
      const oi = d.byCategory['orchestrator-internal'].inputTokens;
      const at = d.byCategory['automation-trigger'].inputTokens;
      const ad = d.byCategory['ad-hoc'].inputTokens;
      out.push(
        `| ${d.date} | ${fmt(oc)} | ${fmt(oi)} | ${fmt(at)} | ${fmt(ad)} | ${fmt(oc + oi + at + ad)} |`,
      );
    }
    out.push('');
  }

  // Tool leaderboard
  if (a.toolLeaderboard.length > 0) {
    out.push('## Tool-call leaderboard');
    out.push('');
    out.push('| Tool | Calls | Attributed input tokens | Share of total |');
    out.push('|---|---:|---:|---:|');
    for (const t of a.toolLeaderboard.slice(0, 30)) {
      out.push(
        `| ${escapeMd(t.toolName)} | ${t.calls.toLocaleString()} | ${fmt(t.inputTokens)} | ${formatPercent(t.share)} |`,
      );
    }
    out.push('');
  }

  // Labels introduced
  const anyIntroduced = LABEL_DIMENSIONS.some((d) => labelsIntroduced[d].length > 0);
  if (anyIntroduced) {
    out.push('## Labels introduced this run');
    out.push('');
    for (const dim of LABEL_DIMENSIONS) {
      const list = labelsIntroduced[dim];
      if (list.length === 0) continue;
      out.push(`**${labelDimensionLabel(dim)}:**`);
      out.push('');
      for (const e of list) {
        out.push(`- \`${e.label}\` — ${escapeMd(e.firstSeenSummary || '(no summary)')}`);
      }
      out.push('');
    }
  }

  // Methodology
  out.push('## Methodology');
  out.push('');
  out.push(`- Window: \`${a.meta.from}\` → \`${a.meta.to}\` (UTC).`);
  out.push(`- Environment: \`${a.meta.env}\`.`);
  out.push(`- Generated at: \`${a.meta.generatedAt}\`.`);
  out.push(
    `- Token→thread join hit rate: **${formatPercent(a.meta.joinHitRate)}** ` +
      `(${a.meta.totalLlmCalls.toLocaleString()} llm_call rows in window).`,
  );
  if (a.meta.classifierModel) {
    out.push(`- Classifier model: \`${a.meta.classifierModel}\`.`);
  } else {
    out.push('- Classifier model: (skipped — attribution only).');
  }
  out.push(
    '- Category rules: trigger-originated → `automation-trigger`; ' +
      'orchestrator session with a channel → `orchestrator-chat`; ' +
      'orchestrator session with no channel → `orchestrator-internal`; ' +
      'everything else → `ad-hoc`.',
  );
  out.push(
    '- Tool→tokens attribution is share-weighted: tokens are split across the tools the thread used in proportion to call count. ' +
      'Rough heuristic; useful for ranking, not for precise per-tool accounting.',
  );

  return out.join('\n') + '\n';
}

function categoryMixSentence(a: Attribution): string {
  const total = a.totals.inputTokens;
  if (total === 0) return '';
  const parts: string[] = [];
  for (const c of CATEGORIES) {
    const v = a.totals.byCategory[c].inputTokens;
    if (v === 0) continue;
    const pct = Math.round((v / total) * 100);
    parts.push(`**${pct}%** ${c}`);
  }
  return parts.join(', ');
}

function labelDimensionLabel(d: LabelDimension): string {
  if (d === 'taskType') return 'Task type';
  if (d === 'costDriver') return 'Cost driver';
  return 'Outcome';
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function dateOnly(iso: string): string {
  // Accept either ISO datetime or already a YYYY-MM-DD.
  return iso.slice(0, 10);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function escapeMd(s: string): string {
  // Strip newlines and escape pipes (would break table rows) and backticks.
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

// Used by the runner; kept here so callers can categorize without the full report.
function _categoryConst(_c: Category) {
  return _c;
}
void _categoryConst;
