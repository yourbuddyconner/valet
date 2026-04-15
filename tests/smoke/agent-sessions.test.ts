/**
 * Agent-dispatched smoke test: child session lifecycle.
 *
 * Tests spawn_session, wait_for_event, read_messages, terminate_session.
 * This directly exercises the prompt queue fix for wait_for_event.
 */

import { describe, it, expect } from 'vitest';
import { SmokeClient } from './client.js';
import { dispatchAndWait, assertSmokeTestResult, type SmokeTestResult } from './agent.js';

const client = new SmokeClient();

const PROMPT = `You are running an automated smoke test for the child session lifecycle. Execute each step below IN ORDER and produce ONLY a JSON object as your final message — no markdown, no commentary, no code fences. The JSON must be parseable.

Steps:

1. SPAWN: Call spawn_session with task="Run these commands and report EXACT output: (1) echo SMOKE_OK (2) node --version (3) git --version. Then you are done." workspace="smoke-test" title="Smoke Child".
2. WAIT: Call wait_for_event with the child's session ID and notify_on="terminal". Record whether it woke correctly and the child's status.
3. READ: Call read_messages for the child session. Record whether you got messages and if "SMOKE_OK" appears.
4. STATUS: Call get_session_status for the child session. Record the status and runnerConnected fields.
5. LIST: Call list_sessions. Record whether the child appears in the list.
6. TERMINATE: Call terminate_session for the child (if not already terminated).
7. VERIFY: Call get_session_status again. Confirm status is "terminated".

Output ONLY this JSON:

{"smoke_test":"sessions","timestamp":"<ISO8601 now>","checks":{"spawn":{"pass":true,"detail":"child_id=X"},"wait_for_event":{"pass":true,"detail":"woke correctly, status=X"},"read_messages":{"pass":true,"detail":"got N messages, SMOKE_OK found: true/false"},"get_status":{"pass":true,"detail":"status=X runner=X"},"list_children":{"pass":true,"detail":"child in list: true/false"},"terminate":{"pass":true,"detail":"terminated"},"verify_terminated":{"pass":true,"detail":"status=terminated"}},"summary":{"total":7,"passed":N,"failed":N}}

Set pass to false and include the error in detail for any step that fails. Do not omit failed checks.`;

describe('agent: child session lifecycle', () => {
  let result: SmokeTestResult;

  it('dispatches prompt and receives JSON response', async () => {
    // Child session spawn + wait can take a while
    const response = await dispatchAndWait(client, PROMPT, { timeoutMs: 180_000 });

    console.log(`Agent responded in ${response.durationMs}ms`);
    console.log(`Raw response (first 500 chars): ${response.raw.slice(0, 500)}`);

    assertSmokeTestResult(response.json);
    result = response.json;
    expect(result.smoke_test).toBe('sessions');

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
});
