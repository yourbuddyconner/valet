/**
 * `/usage` — unified spend dashboard.
 *
 * Shows total spend for the selected window across ALL use cases (engine
 * sessions, orchestrator, workflows, proxy). Token-type breakdown (input /
 * output / cache-read / cache-write) and cache-hit-rate stat visible in the
 * header and By-model table. Org admins can switch to org scope; the byUser
 * table appears in org scope. A team workspace (nav switcher) pins the scope
 * to that team and hides the personal-only surfaces (me/org toggle, proxy
 * request log, key setup). All four use-case rows are expandable via
 * /api/usage/items (symmetric drill-down). CSV export button respects the
 * current window and scope.
 *
 * Data:
 *   GET /api/usage/breakdown?window=&scope=  → UsageBreakdownResponse
 *   GET /api/usage/items?window=&scope=&useCase=  → UsageDrillResponse (lazy on expand)
 *   GET /api/usage/export.csv?window=&scope=      → CSV download
 *   GET /api/proxy/requests   → paginated request log  (unchanged)
 *   GET /api/proxy/settings   → enabled flag           (unchanged)
 */
import { useEffect, useRef, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useUsageBreakdown, useUsageItems, useUsageOutcomes, useUsageToolEfficiency } from "~/api/usage";
import { useProxyRequests, useProxySettings } from "~/api/proxy-usage";
import { useOrg } from "~/api/settings";
import { SpendChart } from "~/components/usage/SpendChart";
import { RequestLog } from "~/components/usage/RequestLog";
import { WorkspaceClause, useActiveWorkspace } from "~/components/workspace-clause";
import type { UsageExportGranularity, UsageUseCase, UsageDrillItem, UsagePeriodSelection, UsageScopeName } from "@valet/api/wire";
import { api } from "~/api/client";

export const Route = createFileRoute("/usage")({
  component: UsagePage,
});

const WINDOWS = ["24h", "7d", "30d"] as const;
type Window = (typeof WINDOWS)[number];

function usageErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "payload" in error) {
    const payload = error.payload;
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const detail = payload.error;
      if (
        typeof detail === "object" &&
        detail !== null &&
        "message" in detail &&
        typeof detail.message === "string"
      ) {
        return detail.message;
      }
    }
  }
  return String(error);
}

function fmt(n: number) {
  return n.toLocaleString();
}

function fmtUsd(n: number) {
  return `$${n.toFixed(4)}`;
}

function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0 rounded border border-line bg-paper p-3 sm:p-4">
      <div className="text-xs text-muted uppercase tracking-wide mb-1">{label}</div>
      <div className="break-words text-lg font-semibold text-ink tabular-nums sm:text-xl">{value}</div>
      {sub && <div className="break-words text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

const USE_CASE_LABELS: Record<UsageUseCase, string> = {
  orchestrator: "Orchestrator",
  session: "Runtimes",
  workflow: "Workflows",
  proxy: "Proxy (external tools)",
};

/** Nest drill items by parentId — roots in order, each followed by children. */
function nestItems(items: UsageDrillItem[]): UsageDrillItem[] {
  const roots: UsageDrillItem[] = [];
  const byParent = new Map<string, UsageDrillItem[]>();

  for (const item of items) {
    if (item.isChild && item.parentId) {
      const bucket = byParent.get(item.parentId) ?? [];
      bucket.push(item);
      byParent.set(item.parentId, bucket);
    } else {
      roots.push(item);
    }
  }

  const result: UsageDrillItem[] = [];
  for (const root of roots) {
    result.push(root);
    for (const child of byParent.get(root.id) ?? []) {
      result.push(child);
    }
  }
  return result;
}

/** Lazy-loaded item list for one use case. */
function ItemList({
  period,
  scope,
  teamId,
  useCase,
}: {
  period: UsagePeriodSelection;
  scope: UsageScopeName;
  teamId: string | undefined;
  useCase: UsageUseCase;
}) {
  const q = useUsageItems(period, scope, useCase, teamId);

  if (q.isLoading) {
    return <p className="text-xs text-muted px-4 py-2">Loading…</p>;
  }
  if (q.error) {
    return (
      <p className="text-xs text-danger-600 px-4 py-2">{String(q.error)}</p>
    );
  }
  const items = nestItems(q.data?.items ?? []);
  if (items.length === 0) {
    return <p className="text-xs text-muted px-4 py-2">No data in this window.</p>;
  }

  return (
    <div className="border-t border-line divide-y divide-line">
      {items.map((item) => {
        const isOrchId = item.sessionId?.startsWith("orchestrator:") ?? false;
        const canLink = item.sessionId !== null && !isOrchId;
        const labelEl = canLink ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: item.sessionId! }}
            className="block min-h-11 max-w-full break-words py-3 text-moss hover:underline underline-offset-2 sm:min-h-0 sm:py-0"
          >
            {item.label}
          </Link>
        ) : (
          <span className="break-words text-muted">{item.label}</span>
        );

        return (
          <div
            key={item.id}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs sm:flex-nowrap ${
              item.isChild ? "pl-8 bg-ink-wash" : ""
            }`}
          >
            <div className="basis-full min-w-0 sm:basis-auto sm:flex-1">{labelEl}</div>
            <span className="tabular-nums text-muted shrink-0">
              {fmtUsd(item.costUsd)}
            </span>
            <span className="tabular-nums text-muted shrink-0 sm:w-20 sm:text-right">
              {fmt(item.totalTokens)} tok
            </span>
            <span className="tabular-nums text-muted shrink-0 sm:w-14 sm:text-right">
              {item.turns} turns
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One expandable use-case row — all four use cases are now expandable. */
function UseCaseRow({
  useCase,
  costUsd,
  totalTokens,
  turns,
  period,
  scope,
  teamId,
}: {
  useCase: UsageUseCase;
  costUsd: number;
  totalTokens: number;
  turns: number;
  period: UsagePeriodSelection;
  scope: UsageScopeName;
  teamId: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-line last:border-0">
      <div
        className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm cursor-pointer sm:flex-nowrap hover:bg-ink-wash"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
        aria-label={`${USE_CASE_LABELS[useCase]} — expand items`}
      >
        <span
          className={`text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden
        >
          ›
        </span>
        <span className="min-w-0 basis-4/5 grow break-words text-ink font-medium sm:basis-auto">{USE_CASE_LABELS[useCase]}</span>
        <span className="tabular-nums text-muted sm:w-24 sm:text-right">{fmtUsd(costUsd)}</span>
        <span className="tabular-nums text-muted sm:w-24 sm:text-right">
          {fmt(totalTokens)} tok
        </span>
        <span className="tabular-nums text-muted sm:w-16 sm:text-right">{turns} turns</span>
      </div>
      {expanded && (
        <ItemList period={period} scope={scope} teamId={teamId} useCase={useCase} />
      )}
    </div>
  );
}

export function UsagePage() {
  const [period, setPeriod] = useState<UsagePeriodSelection>({ kind: "lookback", window: "7d" });
  const [month, setMonth] = useState("");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [exportError, setExportError] = useState<unknown>();
  const [exporting, setExporting] = useState(false);
  const [exportGranularity, setExportGranularity] = useState<UsageExportGranularity>("day");
  const exportLinkRef = useRef<HTMLAnchorElement>(null);
  const [personalScope, setPersonalScope] = useState<"me" | "org">("me");
  // Keep only cursor history, not every loaded row. Each page remains bounded
  // by the server's explicit page size.
  const [pageCursors, setPageCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = pageCursors[pageCursors.length - 1];

  const orgQ = useOrg();
  const isOrgAdmin =
    orgQ.data?.features.organizations === true &&
    orgQ.data?.callerRole === "admin";

  // A team workspace pins the scope to that team; the me/org toggle only
  // exists in the personal workspace. The toggle's state survives a visit to
  // a team workspace, so switching back restores the view you had.
  //
  // The switcher's stored key can name a team the caller has left until the
  // team list loads; useActiveWorkspace resolves to undefined in that window.
  // Firing a team query on the raw key would 404 and flash an error in place
  // of the totals — hold the queries until the workspace can be named.
  const ws = useActiveWorkspace();
  const scopeKnown = ws !== undefined;
  const personalWorkspace = ws?.kind === "personal";
  const teamId = ws?.kind === "team" ? ws.team.id : undefined;
  const scope: UsageScopeName = teamId !== undefined ? "team" : personalScope;
  const todayUtc = new Date().toISOString().slice(0, 10);
  const currentMonthUtc = todayUtc.slice(0, 7);

  const breakdownQ = useUsageBreakdown(period, scope, teamId, { enabled: scopeKnown });
  const toolEfficiencyQ = useUsageToolEfficiency(period, scope, teamId, { enabled: scopeKnown && breakdownQ.isSuccess });
  const outcomesQ = useUsageOutcomes(period, scope, teamId, { enabled: scopeKnown && breakdownQ.isSuccess });
  // Proxy traffic is personal; every consumer of these two queries renders
  // only in the personal workspace, so do not fetch outside it.
  const requestsQ = useProxyRequests({ limit: 25, cursor }, { enabled: personalWorkspace });
  const settingsQ = useProxySettings({ enabled: personalWorkspace });

  // A workspace switch resets the bounded request-log pager. Team records
  // never appear in this personal surface.
  useEffect(() => {
    setPageCursors([undefined]);
  }, [teamId]);

  const breakdown = breakdownQ.data;
  const USE_CASE_ORDER: UsageUseCase[] = [
    "orchestrator",
    "session",
    "workflow",
    "proxy",
  ];

  const modelRows = breakdown?.byModel ?? [];
  const skillRows = breakdown?.skillBreakdown ?? [];
  const byUserRows = breakdown?.byUser ?? [];
  const dailyAgentWindow = scope === "team" ? breakdown?.dailyAgentWindow : undefined;
  const chartBuckets = breakdown?.byDay ?? [];

  // Cache-hit-rate = cacheReadTokens / (inputTokens + cacheReadTokens)
  const cacheHitRate: number | null =
    breakdown && breakdown.totalInputTokens + breakdown.totalCacheReadTokens > 0
      ? breakdown.totalCacheReadTokens /
        (breakdown.totalInputTokens + breakdown.totalCacheReadTokens)
      : null;

  const csvHref = api.usageExportCsvUrl(period, scope, exportGranularity, teamId);
  const periodLabel = period.kind === "lookback"
    ? period.window
    : period.kind === "month"
      ? period.month
      : `${period.start} to ${period.end}`;
  const customPeriodApplied =
    period.kind === "custom" && period.start === customStart && period.end === customEnd;
  const customPeriodPending =
    Boolean(customStart && customEnd && customStart <= customEnd) && !customPeriodApplied;

  function handleWindowChange(w: Window) {
    setMonth("");
    setCustomStart("");
    setCustomEnd("");
    setPeriod({ kind: "lookback", window: w });
  }

  function handleMonthChange(next: string) {
    setMonth(next);
    setCustomStart("");
    setCustomEnd("");
    setPeriod(next ? { kind: "month", month: next } : { kind: "lookback", window: "7d" });
  }

  function applyCustomPeriod() {
    setMonth("");
    setPeriod({ kind: "custom", start: customStart, end: customEnd });
  }

  async function handleCsvDownload() {
    if (exporting) return;
    setExportError(undefined);
    setExporting(true);
    try {
      await api.validateUsageExport(period, scope, exportGranularity, teamId);
      exportLinkRef.current?.click();
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10 space-y-10">
        {/* Header — the workspace clause names the active scope, same as the
            other scoped list pages. */}
        <div>
          <h1 className="font-display text-2xl text-ink flex flex-wrap items-baseline gap-x-3 gap-y-1">
            Usage
            <WorkspaceClause />
          </h1>
          <p className="mt-1 text-sm text-muted">
            {scope === "team"
              ? "Spend across all Valet use cases for this team."
              : "Spend across all Valet use cases for your account."}
          </p>
        </div>

        {/* Disabled-gateway notice */}
        {personalWorkspace && settingsQ.data?.enabled === false && (
          <div className="rounded border border-line bg-paper px-4 py-3 text-sm text-muted">
            The recording gateway is disabled — enable it in{" "}
            <Link
              to="/settings/organization/proxy"
              className="text-moss underline-offset-2 hover:underline"
            >
              Settings → Proxy
            </Link>
            .
          </div>
        )}

        {/* Window selector + scope toggle + CSV export */}
        <div className="flex items-center gap-2 flex-wrap">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => handleWindowChange(w)}
              className={`min-h-11 rounded px-3 py-2 text-sm border sm:min-h-0 sm:py-1 ${
                period.kind === "lookback" && period.window === w
                  ? "border-moss text-moss bg-moss-wash font-medium"
                  : "border-line text-muted hover:text-ink hover:border-ink"
              }`}
            >
              {w}
            </button>
          ))}
          <label className="flex items-center gap-2 text-sm text-muted">
            <span>Month</span>
            <input
              type="month"
              aria-label="Calendar month"
              max={currentMonthUtc}
              value={month}
              onChange={(event) => handleMonthChange(event.target.value)}
              aria-current={period.kind === "month" ? "date" : undefined}
              className={`min-h-11 rounded border bg-paper px-2 sm:min-h-0 ${
                period.kind === "month"
                  ? "border-moss bg-moss-wash font-medium text-moss"
                  : "border-line text-ink"
              }`}
            />
          </label>
          <label className="text-sm text-muted">
            <span className="sr-only">Custom start date</span>
            <input
              type="date"
              aria-label="Custom start date"
              max={todayUtc}
              value={customStart}
              onChange={(event) => setCustomStart(event.target.value)}
              className="min-h-11 rounded border border-line bg-paper px-2 text-ink sm:min-h-0"
            />
          </label>
          <span className="text-sm text-muted">to</span>
          <label className="text-sm text-muted">
            <span className="sr-only">Custom end date</span>
            <input
              type="date"
              aria-label="Custom end date"
              min={customStart}
              max={todayUtc}
              value={customEnd}
              onChange={(event) => setCustomEnd(event.target.value)}
              className="min-h-11 rounded border border-line bg-paper px-2 text-ink sm:min-h-0"
            />
          </label>
          <button
            type="button"
            disabled={!customStart || !customEnd || customStart > customEnd}
            onClick={applyCustomPeriod}
            aria-pressed={customPeriodApplied}
            className={`min-h-11 rounded border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:py-1 ${
              customPeriodApplied
                ? "border-moss bg-moss-wash font-medium text-moss"
                : customPeriodPending
                  ? "border-amber-500 bg-amber-500/10 font-medium text-amber-800 dark:text-amber-300"
                  : "border-line text-muted hover:border-ink hover:text-ink"
            }`}
          >
            Apply dates
          </button>
          {personalWorkspace && isOrgAdmin && (
            <div className="flex items-center gap-1 sm:ml-4 rounded border border-line overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => setPersonalScope("me")}
                className={`min-h-11 px-3 py-2 sm:min-h-0 sm:py-1 ${
                  scope === "me"
                    ? "bg-moss-wash text-moss font-medium"
                    : "text-muted hover:text-ink"
                }`}
                aria-pressed={scope === "me"}
              >
                My usage
              </button>
              <button
                type="button"
                onClick={() => setPersonalScope("org")}
                className={`min-h-11 px-3 py-2 sm:min-h-0 sm:py-1 ${
                  scope === "org"
                    ? "bg-moss-wash text-moss font-medium"
                    : "text-muted hover:text-ink"
                }`}
                aria-pressed={scope === "org"}
              >
                Organization
              </button>
            </div>
          )}
          {scopeKnown && (
            <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
              <label className="text-sm text-muted">
                <span className="sr-only">CSV granularity</span>
                <select
                  aria-label="CSV granularity"
                  value={exportGranularity}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "day" || value === "hour" || value === "turn") setExportGranularity(value);
                  }}
                  className="min-h-11 rounded border border-line bg-paper px-2 text-ink sm:min-h-0 sm:py-1"
                >
                  <option value="day">Daily</option>
                  <option value="hour">Hourly</option>
                  <option value="turn">Itemized (per turn)</option>
                </select>
              </label>
              <button
                type="button"
                disabled={exporting}
                onClick={handleCsvDownload}
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded border border-line px-3 py-2 text-sm text-muted hover:border-ink hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:py-1"
                aria-label={`Download CSV (${periodLabel}, ${scope})`}
              >
                {exporting ? "Validating export…" : `Download CSV (${periodLabel}, ${scope})`}
              </button>
              <a ref={exportLinkRef} href={csvHref} className="sr-only" tabIndex={-1} aria-hidden="true">Download</a>
            </div>
          )}
        </div>
        {exportError !== undefined && (
          <p className="text-sm text-danger-600">{usageErrorText(exportError)}</p>
        )}

        {/* Totals + chart + by-use-case + by-model. A disabled query (scope
            still resolving) reports isLoading=false, so gate on both. */}
        {!scopeKnown || breakdownQ.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : breakdownQ.error ? (
          <p className="text-sm text-danger-600">{usageErrorText(breakdownQ.error)}</p>
        ) : breakdown ? (
          <>
            {/* Total stat cards — cost + token types + cache-hit-rate + unpriced */}
            <div className="grid grid-cols-1 min-[360px]:grid-cols-2 lg:grid-cols-5 gap-3">
              <StatCard label="Active agents" value={fmt(breakdown.activeAgents)} sub="Unique agents with token usage in this period." />
              <StatCard label="Total cost" value={fmtUsd(breakdown.totalCostUsd)} />
              <StatCard label="Total tokens" value={fmt(breakdown.totalTokens)} />
              <StatCard
                label="Input / Output"
                value={`${fmt(breakdown.totalInputTokens)} / ${fmt(breakdown.totalOutputTokens)}`}
              />
              <StatCard
                label="Cache hit rate"
                value={cacheHitRate !== null ? fmtPct(cacheHitRate) : "—"}
                sub={
                  cacheHitRate !== null
                    ? `${fmt(breakdown.totalCacheReadTokens)} read / ${fmt(breakdown.totalCacheWriteTokens)} write`
                    : undefined
                }
              />
            </div>

            {/* Unpriced indicator */}
            {breakdown.unpricedTurns > 0 && (
              <div className="rounded border border-line bg-paper px-4 py-2 text-sm text-muted">
                <span className="font-medium text-ink">{fmt(breakdown.unpricedTurns)} turns unpriced</span>
                {" "}— these turns used custom or dev models with no list price. The cost shown is a floor, not a total.
              </div>
            )}

            {/* Daily spend chart */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">Daily spend</h2>
              <SpendChart buckets={chartBuckets} />
            </div>

            <div>
              <h2 className="text-sm font-medium text-ink mb-2">Tool work per model token</h2>
              <p className="text-xs text-muted mb-3">
                Settled tool calls include handled failures. Workflow tool actions run without a model call at that node.
              </p>
              {toolEfficiencyQ.isLoading ? (
                <p className="text-xs text-muted">Loading tool work…</p>
              ) : toolEfficiencyQ.error ? (
                <p className="text-xs text-danger-600">Tool work could not load. Refresh the page to try again.</p>
              ) : (
                <div className="overflow-x-auto rounded border border-line">
                  <table className="w-full text-sm">
                    <thead className="bg-paper-muted text-muted">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Use case</th>
                        <th className="px-3 py-2 text-right font-medium">Model-directed calls</th>
                        <th className="px-3 py-2 text-right font-medium">Model tokens</th>
                        <th className="px-3 py-2 text-right font-medium">Calls / 1M tokens</th>
                        <th className="px-3 py-2 text-right font-medium">Model-free actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(["session", "workflow"] as const).map((useCase) => {
                        const tool = toolEfficiencyQ.data?.byUseCase.find((r) => r.useCase === useCase);
                        const tokens = breakdown.byUseCase.find((r) => r.useCase === useCase)?.totalTokens ?? 0;
                        const rate = tokens > 0 && tool ? Math.round(tool.modelDirectedCalls * 1_000_000 / tokens) : null;
                        return (
                          <tr key={useCase} className="border-t border-line">
                            <th scope="row" className="px-3 py-2 text-left font-medium">{USE_CASE_LABELS[useCase]}</th>
                            <td className="px-3 py-2 text-right tabular-nums">{fmt(tool?.modelDirectedCalls ?? 0)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmt(tokens)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{rate === null ? "—" : fmt(rate)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmt(tool?.modelFreeActions ?? 0)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <h2 className="text-sm font-medium text-ink mb-2">Outcomes</h2>
              <p className="text-xs text-muted mb-3">
                Confirmed GitHub actions and Slack deliveries. Model spend is allocated evenly across outcomes in each runtime or workflow run during this period.
              </p>
              {outcomesQ.isLoading ? (
                <p className="text-xs text-muted">Loading outcomes…</p>
              ) : outcomesQ.error ? (
                <p className="text-xs text-danger-600">Outcomes could not load. Refresh the page to try again.</p>
              ) : (
                <div className="overflow-x-auto rounded border border-line">
                  <table className="w-full text-sm">
                    <thead className="bg-paper-muted text-muted">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Outcome</th>
                        <th className="px-3 py-2 text-right font-medium">Count</th>
                        <th className="px-3 py-2 text-right font-medium">Allocated model spend</th>
                        <th className="px-3 py-2 text-right font-medium">Est. spend / outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outcomesQ.data?.byOutcome.map((row) => (
                        <tr key={row.kind} className="border-t border-line">
                          <th scope="row" className="px-3 py-2 text-left font-medium">{{
                            pull_request_created: "PRs created",
                            review_submitted: "Reviews submitted",
                            slack_message_sent: "Slack messages sent",
                            slack_dm_sent: "Slack DMs sent",
                          }[row.kind]}</th>
                          <td className="px-3 py-2 text-right tabular-nums">{fmt(row.count)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(row.estimatedCostUsd)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{row.estimatedCostPerOutcomeUsd === null ? "—" : fmtUsd(row.estimatedCostPerOutcomeUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {outcomesQ.data && outcomesQ.data.unpricedTurns > 0 && (
                <p className="text-xs text-muted mt-2">{fmt(outcomesQ.data.unpricedTurns)} unpriced model turns make these spend estimates a floor.</p>
              )}
            </div>

            {/* By use case — all four rows expandable. Keyed by the WORKSPACE
                so a workspace switch remounts the rows: an expanded drill
                list must not carry over into a different workspace's view.
                The me/org toggle deliberately does not remount — an admin
                comparing scopes keeps their expanded rows. */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">By use case</h2>
              <div
                key={teamId ?? "personal"}
                className="rounded border border-line overflow-hidden"
              >
                {/* Header row */}
                <div className="hidden sm:flex items-center gap-3 px-4 py-2 bg-paper-muted border-b border-line text-xs font-medium text-muted">
                  <span className="w-3" />
                  <span className="flex-1">Use case</span>
                  <span className="w-24 text-right">Cost (USD)</span>
                  <span className="w-24 text-right">Tokens</span>
                  <span className="w-16 text-right">Turns</span>
                </div>
                {USE_CASE_ORDER.map((uc) => {
                  const bucket = breakdown.byUseCase.find((b) => b.useCase === uc);
                  if (!bucket) return null;
                  return (
                    <UseCaseRow
                      key={uc}
                      useCase={uc}
                      costUsd={bucket.costUsd}
                      totalTokens={bucket.totalTokens}
                      turns={bucket.turns}
                      period={period}
                      scope={scope}
                      teamId={teamId}
                    />
                  );
                })}
                {breakdown.byUseCase.length === 0 && (
                  <div className="px-4 py-3 text-sm text-muted">
                    No spend recorded in this window.
                  </div>
                )}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-medium text-ink mb-3">Skills</h2>
              {skillRows.length === 0 ? (
                <p className="text-sm text-muted">No skill use in this window.</p>
              ) : (
                <div className="max-w-full overflow-x-auto rounded border border-line">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-paper-muted">
                        <th className="px-3 py-2 text-left font-medium text-muted">Skill</th>
                        <th className="px-3 py-2 text-left font-medium text-muted">Source</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Invocations</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Invokers</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Unassigned</th>
                        <th
                          className="px-3 py-2 text-right font-medium text-muted"
                          title="Estimated skill-body tokens carried across model requests. This is not a billed-token or cost value."
                        >
                          Estimated marginal context tokens
                        </th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Carrying calls</th>
                      </tr>
                    </thead>
                    <tbody>
                      {skillRows.map((row) => (
                        <tr key={row.skillKey} className="border-b border-line last:border-0 hover:bg-ink-wash">
                          <td className="px-3 py-2 text-ink">{row.name}</td>
                          <td className="px-3 py-2 text-muted">
                            {row.origin === "plugin" && row.pluginName
                              ? `Plugin: ${row.pluginName}`
                              : row.origin === "repo" ? "Repository" : "Local"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">{fmt(row.invocations)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">{fmt(row.uniqueInvokers)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">{fmt(row.unassignedInvocations)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">{fmt(row.attributedContextTokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">{fmt(row.carryingCalls)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* By model — with input/output/cache columns */}
            <div>
              <h2 className="text-sm font-medium text-ink mb-3">By model</h2>
              {modelRows.length === 0 ? (
                <p className="text-sm text-muted">No data.</p>
              ) : (
                <div className="max-w-full overflow-x-auto rounded border border-line">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-paper-muted">
                        <th className="px-3 py-2 text-left font-medium text-muted">Model</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Turns</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Input tok</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Output tok</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Cache read</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Cache write</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Cost (USD)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelRows.map((row) => (
                        <tr
                          key={row.model ?? "unknown"}
                          className="border-b border-line last:border-0 hover:bg-ink-wash"
                        >
                          <td
                            className="px-3 py-2 text-ink truncate max-w-[14rem]"
                            title={row.model ?? undefined}
                          >
                            {row.model ?? (
                              <span className="text-muted italic">unknown</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.turns.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.inputTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.outputTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.cacheReadTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.cacheWriteTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            ${row.costUsd.toFixed(4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* By member — whenever the server sent rows: org scope, or a
                team scope where the caller administers the team. The SERVER
                decides who may see per-member spend. */}
            {byUserRows.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-ink mb-3">By member</h2>
                {dailyAgentWindow && (
                  <div className="text-xs text-muted mb-3 space-y-2">
                    <p>Average agents active per day, including child agents and workflows.</p>
                    <details>
                      <summary className="min-h-11 cursor-pointer py-3 sm:min-h-0 sm:py-0">How active agents are counted</summary>
                      <p className="mt-2">
                        Each runtime with recorded token usage counts once per member per UTC day.
                        {" "}Averages cover {dailyAgentWindow.days} UTC calendar {dailyAgentWindow.days === 1 ? "day" : "days"}, including zero-activity days and today so far.
                        {" "}Activity uses the prompt author, then the child’s spawning member; older ordinary runtimes use the runtime owner.
                        {" "}Unattributed activity appears under Team / shared. An agent used by multiple members counts for each.
                        {" "}Spend uses billing attribution and the rolling time range.
                      </p>
                    </details>
                  </div>
                )}
                <div className="max-w-full overflow-x-auto rounded border border-line">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-paper-muted">
                        <th className="px-3 py-2 text-left font-medium text-muted">Member</th>
                        {dailyAgentWindow && <th className="px-3 py-2 text-right font-medium text-muted">Avg daily active agents</th>}
                        <th className="px-3 py-2 text-right font-medium text-muted">Turns</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Tokens</th>
                        <th className="px-3 py-2 text-right font-medium text-muted">Cost (USD)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byUserRows.map((row) => (
                        <tr
                          key={row.userId}
                          className="border-b border-line last:border-0 hover:bg-ink-wash"
                        >
                          <td className="px-3 py-2 text-ink truncate max-w-[14rem]" title={row.name}>
                            {row.name || <span className="text-muted italic">unknown</span>}
                          </td>
                          {dailyAgentWindow && (
                            <td className="px-3 py-2 text-right tabular-nums text-muted">
                              {row.avgDailyActiveAgents?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}
                            </td>
                          )}
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.turns.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {row.totalTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            ${row.costUsd.toFixed(4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : null}

        {/* Proxy (external tools) — request log + drill-down. Proxy traffic is
            always personal (never team-owned), so the log and the key-setup
            callout stay out of a team workspace's view. */}
        {personalWorkspace && (
        <div>
          <h2 className="text-sm font-medium text-ink mb-1">
            Proxy (external tools) — request log
          </h2>
          <p className="text-sm text-muted mb-3">
            Proxy costs are estimates from model rates, not provider invoices. Requests can use organization or personal provider keys.
          </p>
          <p className="text-xs text-muted mb-3">
            Recorded prompts from external tools routed through the gateway.
          </p>
          {requestsQ.error && (
            <p className="text-sm text-danger-600 mb-2">{String(requestsQ.error)}</p>
          )}
          <RequestLog
            items={requestsQ.data?.items ?? []}
            pageNumber={pageCursors.length}
            pageSize={requestsQ.data?.pageSize ?? 25}
            hasPreviousPage={pageCursors.length > 1}
            hasNextPage={requestsQ.data?.hasMore ?? false}
            onPreviousPage={() => setPageCursors((pages) => pages.slice(0, -1))}
            onNextPage={() => {
              const nextCursor = requestsQ.data?.nextCursor;
              if (nextCursor) setPageCursors((pages) => [...pages, nextCursor]);
            }}
            isLoading={requestsQ.isLoading}
          />
        </div>
        )}

        {/* Key setup callout */}
        {personalWorkspace && (
        <div className="rounded border border-line bg-paper px-4 py-3 text-sm text-muted">
          Generate a key and set up your tools in{" "}
          <Link
            to="/settings/proxy"
            className="text-moss underline-offset-2 hover:underline"
          >
            Settings → Proxy
          </Link>
          .
        </div>
        )}
      </div>
    </div>
  );
}
