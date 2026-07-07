#!/usr/bin/env bash
# Local end-to-end smoke for Worker tracing — no Grafana, no Modal, no cloud.
# Boots the real worker under `wrangler dev` against a tiny local OTLP collector and
# asserts: (1) requests produce exported spans, (2) query-string secrets are redacted,
# (3) with no endpoint set, nothing is exported (the no-op). Exits non-zero on failure.
#
# Self-contained from a clean checkout. Two things wrangler does NOT do for a pnpm
# monorepo, which this script handles so `make otel-e2e` works without prior setup:
#   (a) Build workspace deps: the worker bundle imports @valet/shared + @valet/sdk from
#       their compiled dist/. wrangler does not build workspace packages, so esbuild
#       would fail with "Could not resolve @valet/shared". We build just those two below
#       (the plugin packages are bundled from source by esbuild, so they need no pre-build).
#   (b) Substitute config placeholders: wrangler.toml uses ${CF_WORKER_NAME}/
#       ${R2_BUCKET_NAME}/... and wrangler has no native ${VAR} interpolation, so we sed
#       them into a throwaway wrangler.e2e.toml (see below).
# (If you run `wrangler dev` directly instead of via this script, you must do both first.)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
WORKER=packages/worker
PORT=8795
COLLECTOR=/tmp/valet-otel-e2e-collector.mjs
CAPTURED=/tmp/valet-otel-e2e-spans.jsonl
WLOG=/tmp/valet-otel-e2e-wrangler.log
SECRET=LEAKTEST_$$

freeport() { local p; p=$(lsof -ti tcp:"$PORT" 2>/dev/null); [ -n "$p" ] && kill -9 $p 2>/dev/null; return 0; }
cleanup() { pkill -f "$COLLECTOR" 2>/dev/null; [ -n "${WPID:-}" ] && kill "$WPID" 2>/dev/null; freeport; rm -f "$WORKER/wrangler.e2e.toml" "$COLLECTOR"; }
trap cleanup EXIT

cat > "$COLLECTOR" <<'EOF'
import http from 'node:http'; import fs from 'node:fs';
const OUT = process.env.CAP; fs.writeFileSync(OUT, '');
const v = a => a?.stringValue ?? a?.intValue ?? a?.boolValue;
http.createServer((q, s) => { if (q.method==='POST' && q.url.includes('/v1/traces')) { let b=''; q.on('data',c=>b+=c).on('end',()=>{ try { for (const r of JSON.parse(b).resourceSpans??[]) for (const sc of r.scopeSpans??[]) for (const sp of sc.spans??[]) { const at={}; for (const x of sp.attributes??[]) at[x.key]=v(x.value); fs.appendFileSync(OUT, JSON.stringify({name:sp.name,attrs:at})+'\n'); } } catch {} s.writeHead(200); s.end('{}'); }); } else { s.writeHead(200); s.end('{}'); } }).listen(4318, ()=>console.log('up'));
EOF

# Substitute ${...} placeholders so the worker boots locally.
sed -e 's/\${CF_WORKER_NAME}/valet-dev/g' -e 's/\${R2_BUCKET_NAME}/valet-storage/g' \
    -e 's/\${D1_DATABASE_NAME}/valet-db/g' -e 's/\${D1_DATABASE_ID}/00000000-0000-0000-0000-000000000000/g' \
    -e 's/\${[A-Z_]*}//g' "$WORKER/wrangler.toml" > "$WORKER/wrangler.e2e.toml"

# Each run gets a FRESH collector so in-flight exports can't leak across runs.
# $1 = extra `wrangler dev` args (the OTEL var, or empty for the no-op run).
run_worker() {
  pkill -f "$COLLECTOR" 2>/dev/null; freeport; sleep 1
  CAP="$CAPTURED" node "$COLLECTOR" >/dev/null 2>&1 &
  local cpid=$!; sleep 1
  : > "$WLOG"
  ( cd "$WORKER" && npx wrangler dev --config wrangler.e2e.toml --port "$PORT" --ip 127.0.0.1 $1 ) > "$WLOG" 2>&1 &
  WPID=$!
  for _ in $(seq 1 120); do grep -qiE "127.0.0.1:$PORT|localhost:$PORT|Ready on" "$WLOG" && break; sleep 1; done
  sleep 2
  curl -s --max-time 10 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
  curl -s --max-time 10 "http://127.0.0.1:$PORT/health?token=$SECRET" >/dev/null 2>&1
  sleep 4                                   # let waitUntil exports land
  kill "$WPID" 2>/dev/null; wait "$WPID" 2>/dev/null; WPID=
  freeport                                   # kill the leftover workerd still on the port
  sleep 1; kill "$cpid" 2>/dev/null          # then stop this run's collector
}

# (a) Build the two workspace deps the worker bundle imports as dist/ (@valet/shared,
# @valet/sdk). wrangler dev does not build workspace packages; without their dist/
# esbuild fails with "Could not resolve @valet/shared". Plugin packages are bundled from
# source by esbuild, so they need no pre-build. Built in order (sdk depends on shared).
echo "── building worker deps (@valet/shared, @valet/sdk) ──"
# Clear stale tsc incremental state first: a leftover *.tsbuildinfo whose dist/ was
# removed makes incremental tsc believe it is up-to-date and emit NOTHING — then the
# worker bundle fails to resolve the dep. Forcing a clean emit keeps this robust to
# partial prior builds (the .tsbuildinfo lives at the package root, not under dist/).
rm -f packages/shared/tsconfig.tsbuildinfo packages/sdk/tsconfig.tsbuildinfo
if ! pnpm --filter @valet/shared run build; then echo "  ✗ @valet/shared build failed"; exit 1; fi
if ! pnpm --filter @valet/sdk run build; then echo "  ✗ @valet/sdk build failed"; exit 1; fi

fail=0
echo "── enabled: tracing -> local collector ──"
run_worker "--var OTEL_EXPORTER_OTLP_ENDPOINT:http://localhost:4318"
n=$(grep -c '"fetchHandler' "$CAPTURED" 2>/dev/null || echo 0)
if [ "$n" -ge 1 ]; then echo "  ✓ $n fetchHandler span(s) exported"; else echo "  ✗ no spans exported"; fail=1; fi
if grep -q "$SECRET" "$CAPTURED"; then echo "  ✗ query-string secret LEAKED into a span"; fail=1; else echo "  ✓ query-string secret redacted"; fi

echo "── disabled: no endpoint (must be a no-op) ──"
run_worker ""
n=$(wc -l < "$CAPTURED" 2>/dev/null | tr -d ' ')
if [ "${n:-0}" = "0" ]; then echo "  ✓ nothing exported"; else echo "  ✗ $n span(s) exported while disabled"; fail=1; fi

echo ""
[ "$fail" = "0" ] && echo "otel-e2e: PASS" || echo "otel-e2e: FAIL"
exit $fail
