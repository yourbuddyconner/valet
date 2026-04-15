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

const client = new SmokeClient();

const PROMPT = `You are running an automated smoke test. Execute each check below and produce ONLY a JSON object as your final message — no markdown, no commentary, no code fences. The JSON must be parseable.

Checks:

1. MEMORY_WRITE: Write a file at test/smoke-auto.md with content "hello smoke test".
2. MEMORY_READ: Read test/smoke-auto.md and verify it contains "hello smoke test".
3. MEMORY_DELETE: Delete test/smoke-auto.md.
4. TASK_CREATE: Create a task titled "smoke-test-auto".
5. TASK_COMPLETE: Mark that task as completed with result "done".
6. TOOLS_LIST: Call list_tools with no filter. Count the total tools.
7. PERSONA: Call get_my_persona. Record your name and handle.
8. SKILLS_SEARCH: Call search_skills with query "github". Count results.
9. CHANNELS: Call list_channels. Count channels and list the channel types present.
10. MAILBOX: Call mailbox_check. Count unread notifications.

Output ONLY this JSON:

{"smoke_test":"core","timestamp":"<ISO8601 now>","checks":{"memory_write":{"pass":true,"detail":"wrote test/smoke-auto.md"},"memory_read":{"pass":true,"detail":"content matches"},"memory_delete":{"pass":true,"detail":"deleted"},"task_create":{"pass":true,"detail":"created id=X"},"task_complete":{"pass":true,"detail":"marked completed"},"tools_list":{"pass":true,"detail":"N tools"},"persona":{"pass":true,"detail":"name=X handle=Y"},"skills_search":{"pass":true,"detail":"N results"},"channels":{"pass":true,"detail":"N channels, types: [...]"},"mailbox":{"pass":true,"detail":"N unread"}},"summary":{"total":10,"passed":N,"failed":N}}

Set pass to false and include the error in detail for any check that fails. Do not omit failed checks.`;

describe('agent: core capabilities', () => {
  let result: SmokeTestResult;

  it('dispatches prompt and receives JSON response', async () => {
    const response = await dispatchAndWait(client, PROMPT, { timeoutMs: 120_000 });

    console.log(`Agent responded in ${response.durationMs}ms`);
    console.log(`Raw response (first 500 chars): ${response.raw.slice(0, 500)}`);

    assertSmokeTestResult(response.json);
    result = response.json;
    expect(result.smoke_test).toBe('core');

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
});
