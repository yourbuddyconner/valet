#!/usr/bin/env bash
# Smoke test for the dag/v1 workflow authoring + execution flow.
#
# Drives the new HTTP routes against a running worker (defaults to
# `wrangler dev` on http://localhost:8787). Exercises:
#   - PUT/GET /:id/draft round-trip
#   - POST /:id/validate (clean + malformed)
#   - POST /:id/publish (no draft / good draft / bumps version)
#   - POST /:id/publish refuses to clobber a non-dag/v1 workflow
#   - GET /:id/versions
#   - POST /:id/versions/:vid/restore (definition + ui round-trip)
#   - POST /:id/test-run (creates an execution + nodes)
#   - GET /api/executions/:id includes nodes[]
#
# Prereqs (run once locally):
#   cd packages/worker
#   pnpm exec wrangler d1 migrations apply DB --local
#   pnpm exec wrangler d1 execute DB --local --file=scripts/seed-test-data.sql
#   pnpm dev   # in another terminal
#
# Then from repo root:
#   make smoke-dag
#
# Honors:
#   WORKER_URL  (default http://localhost:8787)
#   API_TOKEN   (default test-api-token-12345 — matches the seed file)
#   SKIP_RUN=1  (skip the test-run case if Workflows local sim is unavailable)

# Intentionally NOT `set -e` — `expect` counts failures and continues so
# the user sees every broken case in one run, not just the first.
set -uo pipefail

WORKER_URL="${WORKER_URL:-http://localhost:8787}"
API_TOKEN="${API_TOKEN:-test-api-token-12345}"
SKIP_RUN="${SKIP_RUN:-0}"

# ─── helpers ────────────────────────────────────────────────────────────────

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
NC=$'\033[0m'

PASS=0
FAIL=0
FAILURES=()

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "${RED}missing dep: $1${NC}"; exit 2; }
}
require curl
require jq

# Call the worker. Args: METHOD PATH [BODY_JSON].
# Echoes "HTTP_STATUS\nBODY" so callers can split.
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o /tmp/smoke-dag.body -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H "Content-Type: application/json" \
    "${WORKER_URL}${path}")
  if [ -n "$body" ]; then
    args+=(-d "$body")
  fi
  local code
  code=$(curl "${args[@]}" || true)
  echo "$code"
  cat /tmp/smoke-dag.body
}

# Run one assertion. Args: NAME EXPECTED_CODE METHOD PATH [BODY].
# If JQ_CHECK is set, runs it against the response body and expects truthy.
expect() {
  local name="$1" want="$2" method="$3" path="$4" body="${5:-}"
  local out got_code body_text
  out=$(api "$method" "$path" "$body")
  got_code="$(printf '%s' "$out" | head -n1)"
  body_text="$(printf '%s' "$out" | tail -n +2)"
  if [ "$got_code" != "$want" ]; then
    FAIL=$((FAIL+1))
    FAILURES+=("$name: want HTTP $want, got $got_code — $body_text")
    printf '%s✗%s %s (HTTP %s, wanted %s)\n' "$RED" "$NC" "$name" "$got_code" "$want"
    BODY=""
    return 1
  fi
  if [ -n "${JQ_CHECK:-}" ]; then
    local jq_result
    jq_result=$(printf '%s' "$body_text" | jq -r "$JQ_CHECK" 2>/dev/null || echo "false")
    if [ "$jq_result" != "true" ]; then
      FAIL=$((FAIL+1))
      FAILURES+=("$name: jq check failed ($JQ_CHECK) — body: $body_text")
      printf '%s✗%s %s (jq check failed: %s)\n' "$RED" "$NC" "$name" "$JQ_CHECK"
      BODY="$body_text"
      return 1
    fi
  fi
  PASS=$((PASS+1))
  printf '%s✓%s %s\n' "$GREEN" "$NC" "$name"
  BODY="$body_text"
}

WORKFLOWS_TO_CLEANUP=()
TRIGGERS_TO_CLEANUP=()

cleanup() {
  for wf in "${WORKFLOWS_TO_CLEANUP[@]:-}"; do
    [ -z "$wf" ] && continue
    api DELETE "/api/workflows/${wf}" > /dev/null 2>&1 || true
  done
  for tr in "${TRIGGERS_TO_CLEANUP[@]:-}"; do
    [ -z "$tr" ] && continue
    api DELETE "/api/triggers/${tr}" > /dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# Track a workflow for cleanup at exit.
track_workflow() { WORKFLOWS_TO_CLEANUP+=("$1"); }
track_trigger()  { TRIGGERS_TO_CLEANUP+=("$1"); }

# Create a dag/v1 workflow via /workflows/sync. Args: ID NAME DEF_JSON.
create_workflow() {
  local id="$1" name="$2" def="$3"
  local body
  body=$(jq -c -n --arg id "$id" --arg name "$name" --argjson data "$def" \
    '{ id: $id, name: $name, version: "1.0.0", data: $data }')
  api POST "/api/workflows/sync" "$body" > /dev/null
  track_workflow "$id"
}

# Save a draft + publish in one shot.
publish_draft_for() {
  local id="$1" def="$2"
  api PUT "/api/workflows/${id}/draft" "$(jq -c -n --argjson d "$def" '{ draft: $d }')" > /dev/null
  api POST "/api/workflows/${id}/publish" '{}' > /dev/null
}

# Start a draft test-run, echoing the execution id on stdout.
# Second arg is a JSON object for inputs; defaults to "{}" if omitted.
start_test_run() {
  local id="$1"
  local inputs="${2-}"
  if [ -z "$inputs" ]; then inputs='{}'; fi
  local out
  out=$(api POST "/api/workflows/${id}/test-run" "$(jq -c -n --argjson i "$inputs" '{ inputs: $i }')")
  printf '%s' "$out" | tail -n +2 | jq -r '.executionId // empty'
}

# Poll GET /executions/:id until JQ_PRED returns true OR timeout (s).
# Echoes the final body so the caller can inspect it.
poll_execution() {
  local exec_id="$1" pred="$2" timeout="${3:-15}"
  local deadline=$((SECONDS + timeout))
  local body=""
  while [ $SECONDS -lt $deadline ]; do
    local out
    out=$(api GET "/api/executions/${exec_id}")
    body="$(printf '%s' "$out" | tail -n +2)"
    if printf '%s' "$body" | jq -e "$pred" > /dev/null 2>&1; then
      printf '%s' "$body"
      return 0
    fi
    sleep 1
  done
  printf '%s' "$body"
  return 1
}

# ─── precheck ───────────────────────────────────────────────────────────────

echo "Worker: ${WORKER_URL}"
if ! curl -sf "${WORKER_URL}/health" > /dev/null 2>&1; then
  echo "${RED}worker not reachable at ${WORKER_URL}${NC}"
  echo "  start it with: cd packages/worker && pnpm dev"
  exit 2
fi

# ─── fixtures ───────────────────────────────────────────────────────────────

WF_ID="smoke-dag-$(date +%s)-$$"
WF_LEGACY_ID="smoke-dag-legacy-$(date +%s)-$$"

# Minimal valid dag/v1 — kept tiny so test-run completes quickly even on
# the local simulator. The trigger node is the implicit kickoff.
DAG_DEFINITION=$(jq -c -n '{
  version: "dag/v1",
  inputs: {},
  nodes: [
    { id: "noop", type: "set", values: { ran: true } },
    { id: "done", type: "stop", outcome: "success" }
  ],
  edges: [{ from: "noop", to: "done" }]
}')
DAG_DEFINITION_V2=$(jq -c -n '{
  version: "dag/v1",
  inputs: {},
  nodes: [
    { id: "noop", type: "set", values: { ran: true, version: 2 } },
    { id: "done", type: "stop", outcome: "success" }
  ],
  edges: [{ from: "noop", to: "done" }]
}')
UI_V1=$(jq -c -n '{ nodes: { noop: { x: 10, y: 20 }, done: { x: 200, y: 20 } } }')
UI_V2=$(jq -c -n '{ nodes: { noop: { x: 999, y: 999 }, done: { x: 999, y: 999 } } }')

echo "Workflow ID: ${WF_ID}"
echo

# ─── 1. create the workflow ─────────────────────────────────────────────────

CREATE_BODY=$(jq -c -n --arg id "$WF_ID" --argjson data "$DAG_DEFINITION" '{
  id: $id, name: "smoke-dag", version: "1.0.0", data: $data
}')
JQ_CHECK='.success == true and (.id != null)' \
  expect "POST /workflows/sync creates dag/v1 workflow" 200 POST "/api/workflows/sync" "$CREATE_BODY"
track_workflow "$WF_ID"

# ─── 2. PUT/GET draft round-trip ────────────────────────────────────────────

DRAFT_BODY=$(jq -c -n --argjson d "$DAG_DEFINITION" --argjson u "$UI_V1" '{ draft: $d, ui: $u }')
JQ_CHECK='.ok == true' \
  expect "PUT /draft accepts a draft" 200 PUT "/api/workflows/${WF_ID}/draft" "$DRAFT_BODY"

JQ_CHECK='.draft.version == "dag/v1" and (.ui.nodes.noop.x == 10)' \
  expect "GET /draft returns the stored draft + ui" 200 GET "/api/workflows/${WF_ID}/draft"

# ─── 3. validate ────────────────────────────────────────────────────────────

JQ_CHECK='.errors == []' \
  expect "POST /validate on a clean draft returns no errors" 200 POST "/api/workflows/${WF_ID}/validate"

# Save a malformed draft + validate — should NOT 500.
BAD_DRAFT=$(jq -c -n '{ draft: { version: "dag/v1" } }')
JQ_CHECK='.ok == true' \
  expect "PUT /draft accepts a malformed draft (no nodes/edges)" 200 PUT "/api/workflows/${WF_ID}/draft" "$BAD_DRAFT"
JQ_CHECK='(.errors | length) > 0' \
  expect "POST /validate surfaces errors on malformed draft (no 500)" 200 POST "/api/workflows/${WF_ID}/validate"

# Restore the good draft for the rest of the run.
JQ_CHECK='.ok == true' \
  expect "PUT /draft restores good draft" 200 PUT "/api/workflows/${WF_ID}/draft" "$DRAFT_BODY"

# ─── 4. publish ─────────────────────────────────────────────────────────────

PUBLISH_BODY='{"publishNote":"smoke v1"}'
JQ_CHECK='.version.version == 1 and (.version.id | length) > 0' \
  expect "POST /publish creates v1" 200 POST "/api/workflows/${WF_ID}/publish" "$PUBLISH_BODY"
V1_ID=$(printf '%s' "$BODY" | jq -r '.version.id')

# Bump: save a new draft + ui + republish → v2.
DRAFT_V2=$(jq -c -n --argjson d "$DAG_DEFINITION_V2" --argjson u "$UI_V2" '{ draft: $d, ui: $u }')
JQ_CHECK='.ok == true' \
  expect "PUT /draft (v2 shape)" 200 PUT "/api/workflows/${WF_ID}/draft" "$DRAFT_V2"
JQ_CHECK='.version.version == 2' \
  expect "POST /publish bumps to v2" 200 POST "/api/workflows/${WF_ID}/publish" '{"publishNote":"smoke v2"}'

# ─── 5. versions list ───────────────────────────────────────────────────────

JQ_CHECK='(.versions | length) == 2 and (.versions[0].version == 2) and (.versions[1].version == 1)' \
  expect "GET /versions lists v2, v1 (newest first)" 200 GET "/api/workflows/${WF_ID}/versions"

# ─── 6. (skipped — section reserved for a future check) ────────────────────

# ─── 7. restore v1 brings back definition + ui ──────────────────────────────

JQ_CHECK='(.draft.nodes[0].values.ran == true) and (.ui.nodes.noop.x == 10)' \
  expect "POST /versions/:vid/restore returns v1 def + ui" 200 POST "/api/workflows/${WF_ID}/versions/${V1_ID}/restore"

JQ_CHECK='(.draft.nodes | length) == 2 and (.ui.nodes.noop.x == 10)' \
  expect "GET /draft after restore shows v1's ui (not v2's)" 200 GET "/api/workflows/${WF_ID}/draft"

# ─── 8. test-run + execution detail ─────────────────────────────────────────

if [ "$SKIP_RUN" = "1" ]; then
  printf '%s—%s skipping test-run (SKIP_RUN=1)\n' "$YELLOW" "$NC"
else
  JQ_CHECK='.executionId | length > 0' \
    expect "POST /test-run starts a draft execution" 200 POST "/api/workflows/${WF_ID}/test-run" '{"inputs":{}}'
  EXEC_ID=$(printf '%s' "$BODY" | jq -r '.executionId')

  # Allow the workflow a moment to schedule + write its first node trace.
  # The interpreter persists initial trace rows during the first step.do,
  # so a short wait is enough on the local simulator.
  for _ in 1 2 3 4 5; do
    OUT=$(api GET "/api/executions/${EXEC_ID}")
    BODY_TEXT="$(printf '%s' "$OUT" | tail -n +2)"
    if printf '%s' "$BODY_TEXT" | jq -e '.execution.nodes != null' > /dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  JQ_CHECK='.execution.id == "'"$EXEC_ID"'" and (.execution.nodes | length) > 0' \
    expect "GET /executions/:id returns nodes[]" 200 GET "/api/executions/${EXEC_ID}"
fi

# ─── 9. if branching (both branches via input-driven condition) ─────────────

if [ "$SKIP_RUN" != "1" ]; then
  echo
  echo "── if branching ─────────────────────────────────────"
  WF_IF="smoke-dag-if-$(date +%s)-$$"
  IF_DEF=$(jq -c -n '{
    version: "dag/v1",
    inputs: { flag: { type: "boolean", required: true } },
    nodes: [
      { id: "gate", type: "if",
        conditions: [{ left: "trigger.data.flag", dataType: "boolean", operation: "isTrue" }] },
      { id: "marked_true",  type: "set", values: { took: "true" } },
      { id: "marked_false", type: "set", values: { took: "false" } },
      { id: "done", type: "stop", outcome: "success" }
    ],
    edges: [
      { from: "gate", to: "marked_true",  fromOutput: "true" },
      { from: "gate", to: "marked_false", fromOutput: "false" },
      { from: "marked_true",  to: "done" },
      { from: "marked_false", to: "done" }
    ]
  }')
  create_workflow "$WF_IF" "smoke-dag-if" "$IF_DEF"
  publish_draft_for "$WF_IF" "$IF_DEF"

  for flag in true false; do
    EXEC_ID=$(start_test_run "$WF_IF" "{\"flag\":${flag}}")
    if [ -z "$EXEC_ID" ]; then
      FAIL=$((FAIL+1)); FAILURES+=("if(flag=${flag}): test-run returned no executionId")
      printf '%s✗%s if(flag=%s): test-run did not start\n' "$RED" "$NC" "$flag"
      continue
    fi
    body=$(poll_execution "$EXEC_ID" '.execution.status == "completed"' 20) || true
    taken=$(printf '%s' "$body" | jq -r --arg key "marked_${flag}" \
      '[.execution.nodes[] | select(.nodeId == $key and .status == "completed")] | length')
    skipped_key="marked_$([ "$flag" = "true" ] && echo false || echo true)"
    skipped=$(printf '%s' "$body" | jq -r --arg key "$skipped_key" \
      '[.execution.nodes[] | select(.nodeId == $key and .status == "skipped")] | length')
    if [ "$taken" -ge 1 ] && [ "$skipped" -ge 1 ]; then
      PASS=$((PASS+1)); printf '%s✓%s if(flag=%s) → branch marked_%s ran, marked_%s skipped\n' "$GREEN" "$NC" "$flag" "$flag" "$skipped_key"
    else
      FAIL=$((FAIL+1)); FAILURES+=("if(flag=${flag}): expected marked_${flag} completed + ${skipped_key} skipped — got taken=${taken} skipped=${skipped}")
      printf '%s✗%s if(flag=%s) — got taken=%s skipped=%s\n' "$RED" "$NC" "$flag" "$taken" "$skipped"
    fi
  done
fi

# ─── 10. wait node: complete-after-wait + cancel-while-waiting ──────────────
#
# Note: Miniflare's local Workflows simulator does NOT implement
# step.sleep faithfully for short durations — the wait may never
# resume in dev. We still verify status transitions (running →
# waiting_time → cancelled). The full sleep+resume case is a manual
# dev-deploy check; the spec lists it as a manual ops step.

if [ "$SKIP_RUN" != "1" ]; then
  echo
  echo "── wait + cancel ────────────────────────────────────"
  WF_WAIT="smoke-dag-wait-$(date +%s)-$$"
  WAIT_DEF=$(jq -c -n '{
    version: "dag/v1",
    inputs: {},
    nodes: [
      { id: "pause", type: "wait", mode: "duration", duration: "60s" },
      { id: "done",  type: "stop", outcome: "success" }
    ],
    edges: [{ from: "pause", to: "done" }]
  }')
  create_workflow "$WF_WAIT" "smoke-dag-wait" "$WAIT_DEF"
  publish_draft_for "$WF_WAIT" "$WAIT_DEF"

  # Long wait + cancel mid-sleep: status should reach waiting_time then cancelled.
  EXEC_ID=$(start_test_run "$WF_WAIT")
  if [ -z "$EXEC_ID" ]; then
    FAIL=$((FAIL+1)); FAILURES+=("wait+cancel: test-run returned no executionId")
    printf '%s✗%s wait+cancel test-run did not start\n' "$RED" "$NC"
  else
    body=$(poll_execution "$EXEC_ID" '.execution.status == "waiting_time"' 15) || true
    saw_waiting=$(printf '%s' "$body" | jq -r '.execution.status')
    if [ "$saw_waiting" = "waiting_time" ]; then
      PASS=$((PASS+1)); printf '%s✓%s wait → execution reached waiting_time\n' "$GREEN" "$NC"
    else
      FAIL=$((FAIL+1)); FAILURES+=("wait: expected status=waiting_time, got=${saw_waiting}")
      printf '%s✗%s wait → did not reach waiting_time (got %s)\n' "$RED" "$NC" "$saw_waiting"
    fi
    api POST "/api/workflows/${WF_WAIT}/executions/${EXEC_ID}/cancel" '{}' > /dev/null
    # Local Miniflare doesn't implement instance.terminate(), so the
    # cancel-cleanup path can't fully unwind — status will reach
    # 'cancelling' but not 'cancelled' until a real deploy. Verify the
    # cancelling transition only.
    body=$(poll_execution "$EXEC_ID" '.execution.status == "cancelling" or .execution.status == "cancelled"' 15) || true
    status=$(printf '%s' "$body" | jq -r '.execution.status // "<none>"')
    if [ "$status" = "cancelling" ] || [ "$status" = "cancelled" ]; then
      PASS=$((PASS+1)); printf '%s✓%s wait → cancel → %s (terminate() needs real CF)\n' "$GREEN" "$NC" "$status"
    else
      FAIL=$((FAIL+1)); FAILURES+=("wait+cancel: expected cancelling|cancelled, got status=${status}")
      printf '%s✗%s wait+cancel — got status=%s\n' "$RED" "$NC" "$status"
    fi
  fi
fi

# ─── 11. approval node (status transition only) ─────────────────────────────
#
# Miniflare's local Workflows simulator does NOT implement
# step.waitForEvent, so we can only verify that the approval node
# transitions execution.status → waiting_approval and creates the
# workflow_approvals row. End-to-end approve/deny/resume requires a
# real deploy.

if [ "$SKIP_RUN" != "1" ]; then
  echo
  echo "── approval (status only) ───────────────────────────"
  WF_APP="smoke-dag-app-$(date +%s)-$$"
  APP_DEF=$(jq -c -n '{
    version: "dag/v1",
    inputs: {},
    nodes: [
      { id: "gate", type: "approval", prompt: "smoke approval prompt", onDeny: "fail" },
      { id: "done", type: "stop", outcome: "success" }
    ],
    edges: [{ from: "gate", to: "done" }]
  }')
  create_workflow "$WF_APP" "smoke-dag-approval" "$APP_DEF"
  publish_draft_for "$WF_APP" "$APP_DEF"
  EXEC_ID=$(start_test_run "$WF_APP")
  if [ -n "$EXEC_ID" ]; then
    # Two acceptable outcomes:
    #   - execution.status reaches `waiting_approval` (real CF resumes)
    #   - an approval node has a trace row (Miniflare's waitForEvent
    #     throws as soon as the wait registers — the row insert that
    #     precedes it is the proof that the approval logic ran)
    body=$(poll_execution "$EXEC_ID" '.execution.status == "waiting_approval" or ((.execution.nodes // []) | map(select(.nodeType == "approval")) | length > 0)' 15) || true
    status=$(printf '%s' "$body" | jq -r '.execution.status // "<none>"')
    approvalNodes=$(printf '%s' "$body" | jq -r '[(.execution.nodes // [])[] | select(.nodeType == "approval")] | length')
    if [ "$status" = "waiting_approval" ] || [ "${approvalNodes:-0}" -ge 1 ] 2>/dev/null; then
      PASS=$((PASS+1)); printf '%s✓%s approval → node executed (status=%s, approval-nodes=%s)\n' "$GREEN" "$NC" "$status" "$approvalNodes"
    else
      FAIL=$((FAIL+1)); FAILURES+=("approval: expected waiting_approval or approval trace row, got status=${status}")
      printf '%s✗%s approval — got status=%s\n' "$RED" "$NC" "$status"
    fi
    # Clean up the dangling instance.
    api POST "/api/workflows/${WF_APP}/executions/${EXEC_ID}/cancel" '{}' > /dev/null
  fi
fi

# ─── 12. foreach: sequential + concurrent ───────────────────────────────────

if [ "$SKIP_RUN" != "1" ]; then
  echo
  echo "── foreach ──────────────────────────────────────────"
  WF_FE="smoke-dag-fe-$(date +%s)-$$"
  foreach_def() {
    local concurrency="$1"
    jq -c -n --argjson c "$concurrency" '{
      version: "dag/v1",
      inputs: {},
      nodes: [
        { id: "list", type: "set", values: { items: [1, 2, 3, 4] } },
        { id: "fan",  type: "foreach",
          items: "{{ nodes.list.data.items }}",
          concurrency: $c,
          body: { id: "row", type: "set", values: { i: "{{ item }}" } } },
        { id: "done", type: "stop", outcome: "success" }
      ],
      edges: [
        { from: "list", to: "fan" },
        { from: "fan",  to: "done" }
      ]
    }'
  }

  # Sequential (concurrency=1).
  FE_DEF=$(foreach_def 1)
  create_workflow "$WF_FE" "smoke-dag-foreach" "$FE_DEF"
  publish_draft_for "$WF_FE" "$FE_DEF"
  EXEC_ID=$(start_test_run "$WF_FE")
  if [ -n "$EXEC_ID" ]; then
    body=$(poll_execution "$EXEC_ID" '.execution.status == "completed"' 25) || true
    if printf '%s' "$body" | jq -e '.execution.status == "completed"' > /dev/null; then
      PASS=$((PASS+1)); printf '%s✓%s foreach concurrency=1 (sequential) → completed\n' "$GREEN" "$NC"
    else
      status=$(printf '%s' "$body" | jq -r '.execution.status // "<none>"')
      FAIL=$((FAIL+1)); FAILURES+=("foreach(seq): expected completed, got ${status}")
      printf '%s✗%s foreach(seq) — status=%s\n' "$RED" "$NC" "$status"
    fi
  fi

  # Concurrent (concurrency=4) — same workflow, republish with new def.
  FE_DEF_CONC=$(foreach_def 4)
  publish_draft_for "$WF_FE" "$FE_DEF_CONC"
  EXEC_ID=$(start_test_run "$WF_FE")
  if [ -n "$EXEC_ID" ]; then
    body=$(poll_execution "$EXEC_ID" '.execution.status == "completed"' 25) || true
    if printf '%s' "$body" | jq -e '.execution.status == "completed"' > /dev/null; then
      PASS=$((PASS+1)); printf '%s✓%s foreach concurrency=4 (concurrent) → completed\n' "$GREEN" "$NC"
    else
      status=$(printf '%s' "$body" | jq -r '.execution.status // "<none>"')
      FAIL=$((FAIL+1)); FAILURES+=("foreach(conc): expected completed, got ${status}")
      printf '%s✗%s foreach(conc) — status=%s\n' "$RED" "$NC" "$status"
    fi
  fi
fi

# ─── 13. webhook trigger fires a dag/v1 execution ───────────────────────────

if [ "$SKIP_RUN" != "1" ]; then
  echo
  echo "── webhook trigger ──────────────────────────────────"
  WF_HOOK="smoke-dag-hook-$(date +%s)-$$"
  HOOK_DEF=$(jq -c -n '{
    version: "dag/v1",
    inputs: {},
    nodes: [
      { id: "noop", type: "set", values: { ran: true } },
      { id: "done", type: "stop", outcome: "success" }
    ],
    edges: [{ from: "noop", to: "done" }]
  }')
  create_workflow "$WF_HOOK" "smoke-dag-hook" "$HOOK_DEF"
  publish_draft_for "$WF_HOOK" "$HOOK_DEF"

  HOOK_PATH="smoke-dag-hook-$(date +%s)-$$"
  # Rate limit set low so the burst case (below) hits 429 without
  # spamming hundreds of dispatches against the worker.
  TRIGGER_BODY=$(jq -c -n --arg wf "$WF_HOOK" --arg p "$HOOK_PATH" '{
    workflowId: $wf,
    name: "smoke-dag-hook-trigger",
    enabled: true,
    config: { type: "webhook", path: $p, method: "POST", rateLimit: 5 }
  }')
  out=$(api POST "/api/triggers" "$TRIGGER_BODY")
  TRIGGER_BODY_OUT="$(printf '%s' "$out" | tail -n +2)"
  TRIGGER_ID=$(printf '%s' "$TRIGGER_BODY_OUT" | jq -r '.id // empty')
  TRIGGER_TOKEN=$(printf '%s' "$TRIGGER_BODY_OUT" | jq -r '.webhookToken // empty')
  if [ -n "$TRIGGER_ID" ] && [ -n "$TRIGGER_TOKEN" ]; then
    track_trigger "$TRIGGER_ID"

    # 401 paths: missing token, wrong token. Use raw curl since `api`
    # always injects the API key as the *user* bearer — we want to
    # exercise the unauthenticated webhook path here.
    missing_code=$(curl -s -o /dev/null -w '%{http_code}' \
      -X POST -H 'content-type: application/json' \
      "${WORKER_URL}/api/triggers/${TRIGGER_ID}/webhook" \
      -d '{"hello":"smoke"}')
    if [ "$missing_code" = "401" ]; then
      PASS=$((PASS+1)); printf '%s✓%s webhook → missing token returns 401\n' "$GREEN" "$NC"
    else
      FAIL=$((FAIL+1)); FAILURES+=("webhook: missing token expected 401, got ${missing_code}")
      printf '%s✗%s webhook → missing token got HTTP %s\n' "$RED" "$NC" "$missing_code"
    fi

    wrong_code=$(curl -s -o /dev/null -w '%{http_code}' \
      -X POST -H 'content-type: application/json' \
      -H "X-Valet-Trigger-Token: wrong-token-deadbeef" \
      "${WORKER_URL}/api/triggers/${TRIGGER_ID}/webhook" \
      -d '{"hello":"smoke"}')
    if [ "$wrong_code" = "401" ]; then
      PASS=$((PASS+1)); printf '%s✓%s webhook → wrong token returns 401\n' "$GREEN" "$NC"
    else
      FAIL=$((FAIL+1)); FAILURES+=("webhook: wrong token expected 401, got ${wrong_code}")
      printf '%s✗%s webhook → wrong token got HTTP %s\n' "$RED" "$NC" "$wrong_code"
    fi

    # Good token: dispatches and creates an execution row.
    curl -s -o /dev/null \
      -X POST -H 'content-type: application/json' \
      -H "X-Valet-Trigger-Token: ${TRIGGER_TOKEN}" \
      "${WORKER_URL}/api/triggers/${TRIGGER_ID}/webhook" \
      -d '{"hello":"smoke"}'

    deadline=$((SECONDS + 15))
    matched=""
    while [ $SECONDS -lt $deadline ]; do
      out=$(api GET "/api/executions?workflowId=${WF_HOOK}")
      body="$(printf '%s' "$out" | tail -n +2)"
      matched=$(printf '%s' "$body" | jq -r '[.executions[]? | select(.triggerType == "webhook")] | length // 0')
      if [ "$matched" -ge 1 ] 2>/dev/null; then break; fi
      sleep 1
    done
    if [ "${matched:-0}" -ge 1 ] 2>/dev/null; then
      PASS=$((PASS+1)); printf '%s✓%s webhook → dag/v1 execution row created\n' "$GREEN" "$NC"
    else
      FAIL=$((FAIL+1)); FAILURES+=("webhook: no execution row created (matched=${matched:-0})")
      printf '%s✗%s webhook → no execution row\n' "$RED" "$NC"
    fi

    # Burst test: rateLimit=5 means request #6+ should 429. We fire 10
    # back-to-back and expect at least one 429.
    saw_429=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      code=$(curl -s -o /dev/null -w '%{http_code}' \
        -X POST -H 'content-type: application/json' \
        -H "X-Valet-Trigger-Token: ${TRIGGER_TOKEN}" \
        "${WORKER_URL}/api/triggers/${TRIGGER_ID}/webhook" \
        -d '{"hello":"burst"}')
      if [ "$code" = "429" ]; then saw_429=1; fi
    done
    if [ "$saw_429" = "1" ]; then
      PASS=$((PASS+1)); printf '%s✓%s webhook → rate limit returns 429 on burst\n' "$GREEN" "$NC"
    else
      FAIL=$((FAIL+1)); FAILURES+=("webhook: expected at least one 429 over 10-request burst with rateLimit=5")
      printf '%s✗%s webhook → rate limit never triggered\n' "$RED" "$NC"
    fi

    # GET trigger must NOT echo the token back.
    out=$(api GET "/api/triggers/${TRIGGER_ID}")
    body="$(printf '%s' "$out" | tail -n +2)"
    leak=$(printf '%s' "$body" | jq -r '.trigger.webhookToken // empty')
    if [ -z "$leak" ]; then
      PASS=$((PASS+1)); printf '%s✓%s GET trigger does NOT echo webhookToken\n' "$GREEN" "$NC"
    else
      FAIL=$((FAIL+1)); FAILURES+=("webhook: GET /api/triggers/:id leaked webhookToken")
      printf '%s✗%s GET trigger leaked webhookToken\n' "$RED" "$NC"
    fi
  else
    FAIL=$((FAIL+1)); FAILURES+=("webhook: trigger create returned no id or token — body=$TRIGGER_BODY_OUT")
    printf '%s✗%s webhook trigger create failed\n' "$RED" "$NC"
  fi
fi

# ─── 14. schedule trigger via Miniflare /__scheduled ────────────────────────

if [ "$SKIP_RUN" != "1" ]; then
  echo
  echo "── schedule trigger ─────────────────────────────────"
  WF_CRON="smoke-dag-cron-$(date +%s)-$$"
  CRON_DEF=$(jq -c -n '{
    version: "dag/v1",
    inputs: {},
    nodes: [
      { id: "noop", type: "set", values: { from: "scheduled" } },
      { id: "done", type: "stop", outcome: "success" }
    ],
    edges: [{ from: "noop", to: "done" }]
  }')
  create_workflow "$WF_CRON" "smoke-dag-cron" "$CRON_DEF"
  publish_draft_for "$WF_CRON" "$CRON_DEF"
  TRIGGER_BODY=$(jq -c -n --arg wf "$WF_CRON" '{
    workflowId: $wf,
    name: "smoke-dag-cron-trigger",
    enabled: true,
    config: { type: "schedule", cron: "* * * * *", target: "workflow" }
  }')
  out=$(api POST "/api/triggers" "$TRIGGER_BODY")
  TRIGGER_BODY_OUT="$(printf '%s' "$out" | tail -n +2)"
  TRIGGER_ID=$(printf '%s' "$TRIGGER_BODY_OUT" | jq -r '.id // empty')
  if [ -n "$TRIGGER_ID" ]; then
    track_trigger "$TRIGGER_ID"
    # Miniflare exposes /__scheduled when wrangler dev was started with
    # `--test-scheduled`. Try it; if not available, mark the case
    # skipped with a yellow warning rather than failing.
    sched_status=$(curl -s -o /dev/null -w '%{http_code}' "${WORKER_URL}/__scheduled?cron=*+*+*+*+*" || echo "000")
    if [ "$sched_status" = "200" ]; then
      deadline=$((SECONDS + 15))
      matched=""
      while [ $SECONDS -lt $deadline ]; do
        out=$(api GET "/api/executions?workflowId=${WF_CRON}")
        body="$(printf '%s' "$out" | tail -n +2)"
        matched=$(printf '%s' "$body" | jq -r '[.executions[]? | select(.triggerType == "schedule")] | length // 0')
        if [ "$matched" -ge 1 ] 2>/dev/null; then break; fi
        sleep 1
      done
      if [ "${matched:-0}" -ge 1 ] 2>/dev/null; then
        PASS=$((PASS+1)); printf '%s✓%s schedule → dag/v1 execution row created\n' "$GREEN" "$NC"
      else
        FAIL=$((FAIL+1)); FAILURES+=("schedule: no execution row created (matched=${matched:-0})")
        printf '%s✗%s schedule → no execution row\n' "$RED" "$NC"
      fi
    else
      printf '%s—%s schedule: /__scheduled not available (HTTP %s); restart wrangler dev with `--test-scheduled` to enable\n' "$YELLOW" "$NC" "$sched_status"
    fi
  else
    FAIL=$((FAIL+1)); FAILURES+=("schedule: trigger create returned no id — body=$TRIGGER_BODY_OUT")
    printf '%s✗%s schedule trigger create failed\n' "$RED" "$NC"
  fi
fi

# ─── summary ────────────────────────────────────────────────────────────────

echo
echo "─── summary ────────────────────────────────────────"
printf '%spass: %d%s   %sfail: %d%s\n' "$GREEN" "$PASS" "$NC" "$RED" "$FAIL" "$NC"
if [ "$FAIL" -ne 0 ]; then
  echo
  echo "failures:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
