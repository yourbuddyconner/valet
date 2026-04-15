/**
 * Agent-dispatched smoke test: child session lifecycle.
 *
 * Tests spawn_session, wait_for_event, read_messages, terminate_session.
 * This directly exercises the prompt queue fix for wait_for_event.
 */

import { describe, it, expect } from 'vitest';
import { SmokeClient } from './client.js';
import { dispatchAndWait, assertSmokeTestResult, type SmokeTestResult } from './agent.js';
import { ToolCallTrace } from './tool-trace.js';

const client = new SmokeClient();

const PROMPT = `You are running an automated smoke test for the child session lifecycle. Execute each step below IN ORDER and produce ONLY a JSON object as your final message — no markdown, no commentary, no code fences. The JSON must be parseable.

CRITICAL TESTING RULES (read before starting):
- Each step's EXPECT line describes the exact tool output that constitutes success. Any deviation = pass=false with the LITERAL tool output in detail.
- Do NOT rationalize ambiguous responses. "Not found" when you expected "Deleted" is failure.
- Record literal tool outputs in the detail field, not paraphrases.
- The wait_for_event step is special: it yields. After it returns, you'll be woken by a child event — proceed with steps 3-7 inside that wake turn.

Steps:

1. SPAWN: Call spawn_session with task="Run these commands and report EXACT output: (1) echo SMOKE_OK (2) node --version (3) git --version. Then you are done." workspace="smoke-test" title="Smoke Child".
   EXPECT: response includes "Child session spawned:" followed by a UUID. Capture the UUID as child_id.

2. WAIT: Call wait_for_event with session_ids=[child_id] and notify_on="status_change". This yields your turn — control returns to you on the next child event.
   EXPECT (after wake): you are woken by a child event message. Record the child's status from the wake message ("idle" / "terminated" / etc.). If you are NOT woken within the test timeout, the wait_for_event yield is broken.

3. READ: Call read_messages for the child session.
   EXPECT: response contains the list of child messages. The text "SMOKE_OK" should appear in the child's bash output. Empty messages or missing SMOKE_OK = fail.

4. STATUS: Call get_session_status for the child session.
   EXPECT: response contains a "status" field with a string value and a "runnerConnected" boolean. Missing fields = fail.

5. LIST: Call list_sessions.
   EXPECT: response contains an array of sessions; the child_id from step 1 appears in the list. Child missing from list = fail.

6. TERMINATE: Call terminate_session for the child (skip if already terminated; mark this step pass=true with detail "already terminated" if so).
   EXPECT: response indicates success ("terminated", "success", or similar). Errors or "not found" = fail.

7. VERIFY: Call get_session_status for the child session again.
   EXPECT: response contains status="terminated". Any other status = fail.

Output ONLY this JSON:

{"smoke_test":"sessions","timestamp":"<ISO8601 now>","checks":{"spawn":{"pass":true,"detail":"child_id=<uuid> | <literal>"},"wait_for_event":{"pass":true,"detail":"woke=true status=<literal>"},"read_messages":{"pass":true,"detail":"N messages, SMOKE_OK found: true/false"},"get_status":{"pass":true,"detail":"status=<literal> runner=<literal>"},"list_children":{"pass":true,"detail":"child in list: true/false, N sessions total"},"terminate":{"pass":true,"detail":"<literal>"},"verify_terminated":{"pass":true,"detail":"status=<literal>"}},"summary":{"total":7,"passed":N,"failed":N}}

For any failed check, set pass=false AND put the literal tool output in detail. Do not omit failed checks. Do not adjust summary counts to hide failures.`;

describe('agent: child session lifecycle', () => {
  let result: SmokeTestResult;
  let trace: ToolCallTrace;

  it('dispatches prompt and receives JSON response', async () => {
    // Child session spawn + wait can take a while
    const response = await dispatchAndWait(client, PROMPT, { timeoutMs: 180_000 });

    console.log(`Agent responded in ${response.durationMs}ms`);
    console.log(`Raw response (first 500 chars): ${response.raw.slice(0, 500)}`);

    assertSmokeTestResult(response.json);
    result = response.json;
    expect(result.smoke_test).toBe('sessions');

    trace = new ToolCallTrace(response.messages);
    console.log(`Tool calls observed: ${trace.calls.map((c) => c.toolName).join(', ') || '(none)'}`);
    console.log(`\nAgent smoke test summary: ${result.summary.passed}/${result.summary.total} passed`);
  });

  it('spawn child', () => {
    expect(result?.checks?.spawn?.pass).toBe(true);
  });

  it('wait_for_event', () => {
    expect(result?.checks?.wait_for_event?.pass).toBe(true);
  });

  it('read child messages', () => {
    expect(result?.checks?.read_messages?.pass).toBe(true);
  });

  it('get child status', () => {
    expect(result?.checks?.get_status?.pass).toBe(true);
  });

  it('list children', () => {
    expect(result?.checks?.list_children?.pass).toBe(true);
  });

  it('terminate child', () => {
    expect(result?.checks?.terminate?.pass).toBe(true);
  });

  it('verify terminated', () => {
    expect(result?.checks?.verify_terminated?.pass).toBe(true);
  });

  it('no failures in summary', () => {
    expect(result?.summary?.failed).toBe(0);
  });

  // ─── Tool-trace assertions (independent of agent self-report) ────────────
  // These verify the LITERAL tool calls and results, bypassing any
  // rationalization in the agent's JSON output.

  it('trace: spawn_session was called', () => {
    trace.expectCalled('spawn_session');
  });

  it('trace: wait_for_event was called', () => {
    trace.expectCalled('wait_for_event');
  });

  it('trace: terminate_session was called', () => {
    trace.expectCalled('terminate_session');
  });

  it('trace: tools were called in spawn → wait → terminate order', () => {
    trace.expectOrder('spawn_session', 'wait_for_event', 'terminate_session');
  });

  it('trace: spawn_session result reports a child session id', () => {
    trace.expectResultMatches('spawn_session', /Child session spawned:\s*[a-f0-9-]{36}/);
  });

  it('trace: no tool calls left in non-terminal status (caught wait_for_event suppression bug)', () => {
    trace.expectAllTerminal();
  });

  it('trace: no tool calls ended in error status', () => {
    trace.expectNoErrors();
  });
});
