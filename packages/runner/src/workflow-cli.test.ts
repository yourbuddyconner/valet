import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { compileWorkflowDefinition } from './workflow-compiler.js';

const cliPath = new URL('./workflow-cli.ts', import.meta.url).pathname;

function runCli(args: string[], stdin = ''): { exitCode: number; stdout: string; stderr: string } {
  let proc;
  if (stdin) {
    const tmpPath = `/tmp/workflow-cli-${crypto.randomUUID()}.json`;
    writeFileSync(tmpPath, stdin, 'utf8');
    const shellArgs = args
      .map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`)
      .join(' ');
    const scriptPath = `'${cliPath.replace(/'/g, `'\\''`)}'`;
    const cmd = `bun ${scriptPath} ${shellArgs} < '${tmpPath}'`;
    proc = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8' });
    unlinkSync(tmpPath);
  } else {
    proc = spawnSync('bun', [cliPath, ...args], { encoding: 'utf8' });
  }

  return {
    exitCode: proc.status ?? 1,
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim(),
  };
}

function parseStdoutJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

describe('workflow-cli contract', () => {
  it('validate command returns valid envelope', () => {
    const workflow = {
      steps: [{ id: 'lint', type: 'tool', tool: 'npm_lint' }],
    };

    const result = runCli(
      ['validate', '--workflow-json', '-'],
      JSON.stringify(workflow),
    );

    expect(result.exitCode).toBe(0);
    const envelope = parseStdoutJson<{ ok: boolean; status: string; workflowHash: string }>(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe('valid');
    expect(envelope.workflowHash).toMatch(/^sha256:/);
  });

  it('run command pauses for approval and resume command completes after approval', async () => {
    const workflow = {
      steps: [
        { id: 'lint', type: 'tool', tool: 'npm_lint' },
        { id: 'approve', type: 'approval', prompt: 'Ship?' },
        { id: 'deploy', type: 'tool', tool: 'deploy' },
      ],
    };

    const compiled = await compileWorkflowDefinition(workflow);
    if (!compiled.ok || !compiled.workflowHash) {
      throw new Error('compile failed');
    }

    const payload = JSON.stringify({ workflow, variables: {} });
    const runResult = runCli(
      [
        'run',
        '--execution-id', 'ex_cli',
        '--workflow-hash', compiled.workflowHash,
        '--workspace', '/tmp',
      ],
      payload,
    );

    expect(runResult.exitCode).toBe(0);
    const runEnvelope = parseStdoutJson<{
      status: string;
      requiresApproval: { resumeToken: string } | null;
    }>(runResult.stdout);
    expect(runEnvelope.status).toBe('needs_approval');
    expect(runEnvelope.requiresApproval?.resumeToken).toMatch(/^wrf_rt_/);

    const resumeResult = runCli(
      [
        'resume',
        '--execution-id', 'ex_cli',
        '--resume-token', runEnvelope.requiresApproval!.resumeToken,
        '--decision', 'approve',
        '--workflow-hash', compiled.workflowHash,
        '--workspace', '/tmp',
      ],
      payload,
    );

    expect(resumeResult.exitCode).toBe(0);
    const resumeEnvelope = parseStdoutJson<{
      status: string;
      steps: Array<{ stepId: string }>;
    }>(resumeResult.stdout);
    expect(resumeEnvelope.status).toBe('ok');
    expect(resumeEnvelope.steps.map((step) => step.stepId)).toContain('deploy');
  });

  it('propose command returns proposal envelope', () => {
    const result = runCli([
      'propose',
      '--workflow-id', 'wf_1',
      '--base-hash', 'sha256:abc',
      '--intent', 'Add approval gate',
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = parseStdoutJson<{
      ok: boolean;
      status: string;
      proposal: { baseHash: string; summary: string };
    }>(result.stdout);

    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe('proposal_created');
    expect(envelope.proposal.baseHash).toBe('sha256:abc');
    expect(envelope.proposal.summary).toBe('Add approval gate');
  });

  it('run command exits 20 on workflow hash mismatch', async () => {
    const workflow = {
      steps: [{ id: 'lint', type: 'tool', tool: 'npm_lint' }],
    };
    const payload = JSON.stringify({ workflow, variables: {} });

    const result = runCli(
      [
        'run',
        '--execution-id', 'ex_hash_mismatch',
        '--workflow-hash', 'sha256:deadbeef',
        '--workspace', '/tmp',
      ],
      payload,
    );

    expect(result.exitCode).toBe(20);
    expect(result.stderr).toContain('Workflow hash mismatch');
  });
});
