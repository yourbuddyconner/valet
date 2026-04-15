/**
 * Agent-dispatched smoke test: core capabilities.
 *
 * Sends a structured prompt to the orchestrator that exercises memory,
 * tasks, tools, personas, skills, channels, and mailbox. The agent
 * responds with a JSON report that we parse and assert against.
 */

import { describe, it, expect } from 'vitest';
import { SmokeClient } from './client.js';
import { dispatchAndWait, assertSmokeTestResult, type SmokeTestResult } from './agent.js';
import { ToolCallTrace } from './tool-trace.js';

const client = new SmokeClient();

const PROMPT = `You are running an automated smoke test. Execute each check below and produce ONLY a JSON object as your final message — no markdown, no commentary, no code fences. The JSON must be parseable.

CRITICAL TESTING RULES (read before starting):
- Each check has an explicit EXPECT line describing the exact tool output that constitutes success.
- If the tool returns ANYTHING other than what EXPECT specifies — including ambiguous strings like "Not found", "error", empty results when content is expected, or a different shape — set pass=false for that check and put the LITERAL tool output in the detail field. Do NOT rationalize ("the tool may have meant success", "the response is just weirdly formatted", etc.) — that defeats the test.
- Record the LITERAL output of each tool in the detail field, not your interpretation. The test framework cross-checks these against the tool descriptions; rewording loses fidelity.
- Run independent checks in parallel where possible. Run dependent steps sequentially.

Checks:

1. MEMORY_WRITE: Call mem_write with path="test/smoke-auto.md", content="hello smoke test".
   EXPECT: response contains "Written" and the path. Any other response = fail.
2. MEMORY_READ: Call mem_read with path="test/smoke-auto.md".
   EXPECT: response equals "hello smoke test" (exact match, no extra wrapping). Any other response = fail.
3. MEMORY_DELETE: Call mem_rm with path="test/smoke-auto.md".
   EXPECT: response starts with "Deleted:" and includes the path. "Not found", "Failed", or any other non-"Deleted" prefix = fail (this caught a real bug — do not rationalize).
4. MEMORY_DELETE_VERIFY: Call mem_read with path="test/smoke-auto.md" again.
   EXPECT: response is "File not found" (or equivalent missing-file response). If the file content comes back, mem_rm silently failed = fail this check AND retroactively flip memory_delete to fail.
5. TASK_CREATE: Call task_create with title="smoke-test-auto".
   EXPECT: response contains a UUID-shaped task id and "(pending)" or status indicator. Capture the task id.
6. TASK_COMPLETE: Call task_update with task_id=<from step 5>, state="completed", result="done".
   EXPECT: response indicates the task is now "completed". Status remaining as "pending" = fail.
7. TOOLS_LIST: Call list_tools with no filter.
   EXPECT: response is a non-empty list with at least 50 tools. Record the actual count. <50 or empty = fail.
8. PERSONA: Call get_my_persona.
   EXPECT: response includes a non-empty name and handle. Record both LITERAL strings. Empty/null = fail.
9. SKILLS_SEARCH: Call search_skills with query="github".
   EXPECT: response includes at least 1 result (a "Github" skill exists). 0 results = fail.
10. CHANNELS: Call list_channels.
    EXPECT: response is a list (may be empty for a fresh org). Record the count and the deduplicated set of channel types present.
11. MAILBOX: Call mailbox_check.
    EXPECT: response is parseable as a count of unread notifications (number, possibly 0). Record the count. Errors or unparseable response = fail.

Output ONLY this JSON:

{"smoke_test":"core","timestamp":"<ISO8601 now>","checks":{"memory_write":{"pass":true,"detail":"<literal tool output>"},"memory_read":{"pass":true,"detail":"<literal tool output>"},"memory_delete":{"pass":true,"detail":"<literal tool output>"},"memory_delete_verify":{"pass":true,"detail":"<literal tool output>"},"task_create":{"pass":true,"detail":"id=<task id> | <literal tool output>"},"task_complete":{"pass":true,"detail":"<literal tool output>"},"tools_list":{"pass":true,"detail":"N tools"},"persona":{"pass":true,"detail":"name=<literal> handle=<literal>"},"skills_search":{"pass":true,"detail":"N results"},"channels":{"pass":true,"detail":"N channels, types: [...]"},"mailbox":{"pass":true,"detail":"N unread"}},"summary":{"total":11,"passed":N,"failed":N}}

For any failed check, set pass=false AND put the literal tool output in detail. Do not omit failed checks. Do not adjust the summary counts to hide failures.`;

describe('agent: core capabilities', () => {
  let result: SmokeTestResult;
  let trace: ToolCallTrace;

  it('dispatches prompt and receives JSON response', async () => {
    const response = await dispatchAndWait(client, PROMPT, { timeoutMs: 120_000 });

    console.log(`Agent responded in ${response.durationMs}ms`);
    console.log(`Raw response (first 500 chars): ${response.raw.slice(0, 500)}`);

    assertSmokeTestResult(response.json);
    result = response.json;
    expect(result.smoke_test).toBe('core');

    trace = new ToolCallTrace(response.messages);
    console.log(`Tool calls observed: ${trace.calls.map((c) => c.toolName).join(', ') || '(none)'}`);
    console.log(`\nAgent smoke test summary: ${result.summary.passed}/${result.summary.total} passed`);
  });

  it('memory write', () => {
    expect(result?.checks?.memory_write?.pass).toBe(true);
  });

  it('memory read', () => {
    expect(result?.checks?.memory_read?.pass).toBe(true);
  });

  it('memory delete', () => {
    expect(result?.checks?.memory_delete?.pass).toBe(true);
  });

  it('memory delete verify (file actually gone)', () => {
    expect(result?.checks?.memory_delete_verify?.pass).toBe(true);
  });

  it('task create', () => {
    expect(result?.checks?.task_create?.pass).toBe(true);
  });

  it('task complete', () => {
    expect(result?.checks?.task_complete?.pass).toBe(true);
  });

  it('tools list', () => {
    expect(result?.checks?.tools_list?.pass).toBe(true);
  });

  it('persona', () => {
    expect(result?.checks?.persona?.pass).toBe(true);
  });

  it('skills search', () => {
    expect(result?.checks?.skills_search?.pass).toBe(true);
  });

  it('channels', () => {
    expect(result?.checks?.channels?.pass).toBe(true);
  });

  it('mailbox', () => {
    expect(result?.checks?.mailbox?.pass).toBe(true);
  });

  it('no failures in summary', () => {
    expect(result?.summary?.failed).toBe(0);
  });

  // ─── Tool-trace assertions (independent of agent self-report) ────────────
  // Asserts the LITERAL tool calls and result strings, not the agent's
  // interpretation. Catches the mem_rm class of bugs where the tool reports
  // failure but the agent rationalizes it as success (or vice versa).

  it('trace: mem_write was called and reported "Written"', () => {
    trace.expectCalled('mem_write').expectResultMatches('mem_write', /Written/);
  });

  it('trace: mem_read returned the written content', () => {
    trace.expectCalled('mem_read').expectResultMatches('mem_read', /hello smoke test/);
  });

  it('trace: mem_rm reported "Deleted" (not "Not found" — caught a real bug)', () => {
    trace
      .expectCalled('mem_rm')
      .expectResultMatches('mem_rm', /^Deleted: /)
      .expectResultDoesNotMatch('mem_rm', /^Not found:/);
  });

  it('trace: task_create was called', () => {
    trace.expectCalled('task_create');
  });

  it('trace: task_update was called after task_create', () => {
    trace.expectCalled('task_update').expectOrder('task_create', 'task_update');
  });

  it('trace: list_tools was called', () => {
    trace.expectCalled('list_tools');
  });

  it('trace: get_my_persona was called', () => {
    trace.expectCalled('get_my_persona');
  });

  it('trace: search_skills was called', () => {
    trace.expectCalled('search_skills');
  });

  it('trace: list_channels was called', () => {
    trace.expectCalled('list_channels');
  });

  it('trace: mailbox_check was called', () => {
    trace.expectCalled('mailbox_check');
  });

  it('trace: no orphaned non-terminal tool calls', () => {
    trace.expectAllTerminal();
  });
});
