/**
 * Agent-dispatched smoke test: GitHub integration.
 *
 * Sends a structured prompt that exercises all GitHub actions via call_tool.
 * The agent responds with a JSON report.
 */

import { describe, it, expect } from 'vitest';
import { SmokeClient } from './client.js';
import { dispatchAndWait, assertSmokeTestResult, type SmokeTestResult } from './agent.js';

const client = new SmokeClient();

const PROMPT = `You are running an automated smoke test for the GitHub integration. Execute each check below and produce ONLY a JSON object as your final message — no markdown, no commentary, no code fences. The JSON must be parseable.

Checks:

1. TOOLS_LIST: Call list_tools with service=github. Count the tools. Verify NONE of them have a "source" parameter.
2. LIST_REPOS: Call call_tool github:github.list_repos with no params. Count repos returned.
3. GET_REPO: Call call_tool github:github.get_repository with params {"owner":"ProofLabDev","repo":"api"}. Record: private (bool), default_branch, full_name.
4. LIST_ISSUES: Call call_tool github:github.list_issues with params {"owner":"ProofLabDev","repo":"api","state":"all","per_page":3}. Count issues returned.
5. LIST_PRS: Call call_tool github:github.list_pull_requests with params {"owner":"ProofLabDev","repo":"api","state":"all","per_page":3}. Count PRs returned.
6. SEARCH_CODE: Call call_tool github:github.search_code with params {"q":"repo:ProofLabDev/api language:typescript"}. Record total_count from result.
7. READ_FILE: Call call_tool github:github.read_repo_file with params {"owner":"ProofLabDev","repo":"api","path":"README.md"}. Did it return non-empty content?

Output ONLY this JSON:

{"smoke_test":"github","timestamp":"<ISO8601 now>","checks":{"tools_list":{"pass":true,"detail":"N tools, no source param: true/false"},"list_repos":{"pass":true,"detail":"N repos"},"get_repo":{"pass":true,"detail":"private=X branch=X name=X"},"list_issues":{"pass":true,"detail":"N issues"},"list_prs":{"pass":true,"detail":"N PRs"},"search_code":{"pass":true,"detail":"N results"},"read_file":{"pass":true,"detail":"got content: true/false"}},"summary":{"total":7,"passed":N,"failed":N}}

Set pass to false and include the error in detail for any check that fails. Do not omit failed checks.`;

describe('agent: github integration', () => {
  let result: SmokeTestResult;

  it('dispatches prompt and receives JSON response', async () => {
    const response = await dispatchAndWait(client, PROMPT, { timeoutMs: 120_000 });

    console.log(`Agent responded in ${response.durationMs}ms`);
    console.log(`Raw response (first 500 chars): ${response.raw.slice(0, 500)}`);

    assertSmokeTestResult(response.json);
    result = response.json;
    expect(result.smoke_test).toBe('github');

    console.log(`\nAgent smoke test summary: ${result.summary.passed}/${result.summary.total} passed`);
  });

  it('tools list (no source param)', () => {
    expect(result?.checks?.tools_list?.pass).toBe(true);
  });

  it('list repos', () => {
    expect(result?.checks?.list_repos?.pass).toBe(true);
  });

  it('get repository', () => {
    expect(result?.checks?.get_repo?.pass).toBe(true);
  });

  it('list issues', () => {
    expect(result?.checks?.list_issues?.pass).toBe(true);
  });

  it('list pull requests', () => {
    expect(result?.checks?.list_prs?.pass).toBe(true);
  });

  it('search code', () => {
    expect(result?.checks?.search_code?.pass).toBe(true);
  });

  it('read file', () => {
    expect(result?.checks?.read_file?.pass).toBe(true);
  });

  it('no failures in summary', () => {
    expect(result?.summary?.failed).toBe(0);
  });
});
