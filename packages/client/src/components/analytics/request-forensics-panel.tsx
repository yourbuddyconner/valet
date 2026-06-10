import type { RequestForensicsResponse, RequestSample } from '@valet/shared';

type AccessDenial = RequestForensicsResponse['accessDenials'][number];

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : '—';
}

const cardClass =
  'animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none';
const thClass = 'pb-2 text-left font-mono text-2xs font-medium text-neutral-400';
const tdClass = 'py-2.5 font-mono text-xs text-neutral-600 dark:text-neutral-300';

function AccessDenialsTable({ rows }: { rows: AccessDenial[] }) {
  return (
    <div className={cardClass}>
      <h3 className="label-mono text-neutral-400 mb-1">Access Denials</h3>
      <p className="mb-4 text-2xs text-neutral-400">Repeated 401/403 by actor + route — probing or broken object-level authorization.</p>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-300">No denied requests</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-100 dark:border-neutral-800">
                <th className={`${thClass} pr-4`}>Actor</th>
                <th className={`${thClass} px-4`}>Route</th>
                <th className={`${thClass} px-4 text-right`}>Status</th>
                <th className={`${thClass} pl-4 text-right`}>Count</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={`${r.userId}-${r.route}-${r.status}-${idx}`} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                  <td className={`${tdClass} pr-4`}>{r.userId ? shortId(r.userId) : 'anon'}</td>
                  <td className={`${tdClass} px-4 text-neutral-900 dark:text-neutral-100`}>{r.route}</td>
                  <td className={`${tdClass} px-4 text-right tabular-nums`}>{r.status}</td>
                  <td className={`${tdClass} pl-4 text-right tabular-nums`}>{r.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SamplesTable({ title, blurb, rows, metric }: { title: string; blurb: string; rows: RequestSample[]; metric: 'bytes' | 'duration' }) {
  return (
    <div className={cardClass}>
      <h3 className="label-mono text-neutral-400 mb-1">{title}</h3>
      <p className="mb-4 text-2xs text-neutral-400">{blurb}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-300">No data</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-100 dark:border-neutral-800">
                <th className={`${thClass} pr-4`}>Route</th>
                <th className={`${thClass} px-4 text-right`}>{metric === 'bytes' ? 'Size' : 'Duration'}</th>
                <th className={`${thClass} px-4 text-right`}>Status</th>
                <th className={`${thClass} pl-4 text-right`}>Request ID</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={`${r.requestId}-${idx}`} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
                  <td className={`${tdClass} pr-4 text-neutral-900 dark:text-neutral-100`}>
                    <span className="text-neutral-400">{r.method}</span> {r.route}
                  </td>
                  <td className={`${tdClass} px-4 text-right tabular-nums`}>
                    {metric === 'bytes' ? formatBytes(r.requestBytes) : formatDuration(r.durationMs)}
                  </td>
                  <td className={`${tdClass} px-4 text-right tabular-nums ${r.status >= 500 ? 'text-red-600 dark:text-red-400' : ''}`}>{r.status}</td>
                  <td className={`${tdClass} pl-4 text-right`} title={r.requestId ?? undefined}>{shortId(r.requestId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function RequestForensicsPanel({ data }: { data: RequestForensicsResponse }) {
  return (
    <div className="space-y-6">
      <h3 className="label-mono text-neutral-400">Security &amp; Reliability</h3>
      <AccessDenialsTable rows={data.accessDenials} />
      <div className="grid gap-6 lg:grid-cols-2">
        <SamplesTable
          title="Heaviest Requests"
          blurb="Largest inbound payloads — large-file ingress; a 5xx status flags parse/processing failures."
          rows={data.heavyRequests}
          metric="bytes"
        />
        <SamplesTable
          title="Slowest Requests"
          blurb="Longest-running calls — timeout-prone paths. Pivot the request ID into logs to see the cause."
          rows={data.slowestRequests}
          metric="duration"
        />
      </div>
    </div>
  );
}
