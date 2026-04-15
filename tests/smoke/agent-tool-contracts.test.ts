/**
 * Agent-dispatched smoke test: tool contract negative paths.
 *
 * Exercises the failure / edge cases of common tools to catch contract
 * violations like the mem_rm bug where the success-vs-failure response
 * was indistinguishable. Each check has explicit literal expectations
 * and the agent is forbidden from rationalizing ambiguous responses.
 */

import { describe, it, expect } from 'vitest';
import { SmokeClient } from './client.js';
import { dispatchAndWait, assertSmokeTestResult, type SmokeTestResult } from './agent.js';
import { ToolCallTrace } from './tool-trace.js';

const client = new SmokeClient();

const PROMPT = `You are running an automated smoke test that exercises tool failure paths and edge cases. Produce ONLY a JSON object as your final message — no markdown, no commentary, no code fences. The JSON must be parseable.

CRITICAL TESTING RULES (read before starting):
- Each check describes the EXPECTED tool response. If the actual response differs in any meaningful way — including ambiguous strings, wrong shape, or missing fields — set pass=false for that check and put the LITERAL tool output in the detail field.
- Do NOT rationalize: a tool returning "Not found" when you expected "Deleted" is a FAILURE, not "the response is just weirdly formatted".
- Record the LITERAL tool output in detail, not a paraphrase.
- Many checks here are intentionally testing failure responses — a clean failure response is success for the test, and a success response when failure is expected is the test failure.

Checks:

1. MEM_RM_NONEXISTENT: Call mem_rm with path="test/does-not-exist-${Date.now()}.md".
   EXPECT: response equals "Not found: test/does-not-exist-..." or starts with "Not found:". A "Deleted:" response = fail (means the tool lied about deleting nothing).

2. MEM_READ_MISSING: Call mem_read with path="test/never-existed.md".
   EXPECT: response equals "File not found: test/never-existed.md" (or equivalent missing-file response). Returning content = fail.

3. MEM_WRITE_THEN_DELETE_ROUND_TRIP: Call mem_write with path="test/contract-roundtrip.md" content="contract-test". Then call mem_rm with path="test/contract-roundtrip.md". Then call mem_read with path="test/contract-roundtrip.md".
   EXPECT (this is one combined check):
     - mem_write returns "Written" + path
     - mem_rm returns "Deleted:" + path (NOT "Not found:" — that was a real bug in this tool)
     - mem_read returns missing-file response
   If ANY of the three steps returns the wrong shape, pass=false. Put all three literal outputs in detail joined by " | ".

4. TASK_UPDATE_MISSING: Call task_update with task_id="00000000-0000-0000-0000-000000000000", state="completed".
   EXPECT: response indicates failure ("Task not found", "error", or similar). A success response = fail (means we updated something nonexistent).

5. SPAWN_INVALID_WORKSPACE: Call spawn_session with task="x", workspace="" (empty string), title="empty-workspace-test".
   EXPECT: tool refuses with a validation error. Successful spawn with an empty workspace = fail.

6. TERMINATE_INVALID_SESSION: Call terminate_session with session_id="00000000-0000-0000-0000-000000000000".
   EXPECT: response indicates "not found" / "not a child" / similar failure. A success response = fail.

7. SEARCH_SKILLS_EMPTY_QUERY: Call search_skills with query="".
   EXPECT: either rejects empty query with a clear error, OR returns a defined result list (possibly all skills). An exception trace, undefined, or null = fail.

8. LIST_TOOLS_FILTER: Call list_tools with service="github".
   EXPECT: response is a list where every entry's id starts with "github:". Non-github entries leaking through = fail. Record the count.

9. MEM_WRITE_DEEP_PATH: Call mem_write with path="test/a/b/c/deep.md" content="deep". Then call mem_read with path="test/a/b/c/deep.md".
   EXPECT: write succeeds, read returns "deep" (exactly). Any truncation or path mangling = fail. Cleanup: call mem_rm with path="test/a/b/c/deep.md" (do not include this cleanup in any check; it is best-effort).

10. GET_PERSONA_DETERMINISTIC: Call get_my_persona twice in a row.
    EXPECT: both calls return the same name and handle. Different responses = fail (state inconsistency).

Output ONLY this JSON:

{"smoke_test":"tool_contracts","timestamp":"<ISO8601 now>","checks":{"mem_rm_nonexistent":{"pass":true,"detail":"<literal>"},"mem_read_missing":{"pass":true,"detail":"<literal>"},"mem_round_trip":{"pass":true,"detail":"<write> | <rm> | <read>"},"task_update_missing":{"pass":true,"detail":"<literal>"},"spawn_invalid_workspace":{"pass":true,"detail":"<literal>"},"terminate_invalid_session":{"pass":true,"detail":"<literal>"},"search_skills_empty_query":{"pass":true,"detail":"<literal>"},"list_tools_filter":{"pass":true,"detail":"N github tools, leaks=true/false"},"mem_write_deep_path":{"pass":true,"detail":"<write> | <read>"},"get_persona_deterministic":{"pass":true,"detail":"name1=X handle1=Y name2=X handle2=Y match=true/false"}},"summary":{"total":10,"passed":N,"failed":N}}

For any failed check, set pass=false and put the literal tool output in detail. Do not omit failed checks. Do not adjust summary counts to hide failures.`;

describe('agent: tool contracts', () => {
  let result: SmokeTestResult;
  let trace: ToolCallTrace;

  it('dispatches prompt and receives JSON response', async () => {
    const response = await dispatchAndWait(client, PROMPT, { timeoutMs: 180_000 });

    console.log(`Agent responded in ${response.durationMs}ms`);
    console.log(`Raw response (first 500 chars): ${response.raw.slice(0, 500)}`);

    assertSmokeTestResult(response.json);
    result = response.json;
    expect(result.smoke_test).toBe('tool_contracts');

    trace = new ToolCallTrace(response.messages);
    console.log(`Tool calls observed: ${trace.calls.map((c) => c.toolName).join(', ') || '(none)'}`);
    console.log(`\nAgent smoke test summary: ${result.summary.passed}/${result.summary.total} passed`);
  });

  it('mem_rm on nonexistent file reports not-found cleanly', () => {
    expect(result?.checks?.mem_rm_nonexistent?.pass).toBe(true);
  });

  it('mem_read on missing file reports not-found cleanly', () => {
    expect(result?.checks?.mem_read_missing?.pass).toBe(true);
  });

  it('mem write/rm/read round trip distinguishes deletion from absence', () => {
    expect(result?.checks?.mem_round_trip?.pass).toBe(true);
  });

  it('task_update on nonexistent task fails cleanly', () => {
    expect(result?.checks?.task_update_missing?.pass).toBe(true);
  });

  it('spawn_session rejects empty workspace', () => {
    expect(result?.checks?.spawn_invalid_workspace?.pass).toBe(true);
  });

  it('terminate_session on invalid id fails cleanly', () => {
    expect(result?.checks?.terminate_invalid_session?.pass).toBe(true);
  });

  it('search_skills with empty query is well-defined', () => {
    expect(result?.checks?.search_skills_empty_query?.pass).toBe(true);
  });

  it('list_tools service filter excludes other services', () => {
    expect(result?.checks?.list_tools_filter?.pass).toBe(true);
  });

  it('mem_write/read survives deep path', () => {
    expect(result?.checks?.mem_write_deep_path?.pass).toBe(true);
  });

  it('get_my_persona is deterministic across calls', () => {
    expect(result?.checks?.get_persona_deterministic?.pass).toBe(true);
  });

  it('no failures in summary', () => {
    expect(result?.summary?.failed).toBe(0);
  });

  // ─── Tool-trace assertions (independent of agent self-report) ────────────
  // These assert the LITERAL tool result strings — the agent can't rationalize
  // around them. The "round trip" assertion in particular is the canonical
  // mem_rm regression test: write→rm→read must yield Written, Deleted, missing.

  it('trace: mem_rm called with nonexistent path returns "Not found:" (not "Deleted")', () => {
    // The first mem_rm in the prompt targets a path that was never written.
    // We expect at least one "Not found:" result and no "Deleted:" for that path.
    trace
      .expectCalled('mem_rm')
      .expectResultMatches('mem_rm', /^Not found:/);
  });

  it('trace: mem_round_trip — at least one mem_rm result reports "Deleted:"', () => {
    // The round-trip step writes contract-roundtrip.md then deletes it.
    // The mem_rm for that path MUST report "Deleted:" — this is the literal
    // bug the smoke test caught (was always reporting "Not found").
    trace.expectResultMatches('mem_rm', /^Deleted: /);
  });

  it('trace: mem_read on missing file returns "File not found"', () => {
    trace.expectResultMatches('mem_read', /^File not found/);
  });

  it('trace: list_tools service filter — github filter only returns github tools', () => {
    const calls = trace.filter('list_tools');
    // Find the call where args.service === 'github' and assert no leakage in result.
    const githubCall = calls.find(
      (c) => c.args && typeof c.args === 'object' && (c.args as Record<string, unknown>).service === 'github',
    );
    expect(githubCall).toBeDefined();
    if (githubCall && typeof githubCall.result === 'string') {
      // Crude but effective: every line starting with a tool id should start with 'github:'.
      const nonGithubLeaks = githubCall.result
        .split('\n')
        .filter((line) => /^[a-z_]+:[a-z_.]+/.test(line.trim()) && !line.includes('github:'));
      expect(nonGithubLeaks).toEqual([]);
    }
  });

  it('trace: get_my_persona was called at least twice (determinism check needs ≥2 calls)', () => {
    trace.expectCalled('get_my_persona', { atLeast: 2 });
  });

  it('trace: no orphaned non-terminal tool calls', () => {
    trace.expectAllTerminal();
  });
});
