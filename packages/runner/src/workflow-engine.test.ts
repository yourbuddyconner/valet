import { describe, expect, it } from 'bun:test';
import { compileWorkflowDefinition } from './workflow-compiler.js';
import { executeWorkflowRun, executeWorkflowResume } from './workflow-engine.js';

describe('workflow-engine', () => {
  it('returns needs_approval with resume token for approval steps', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'lint', type: 'tool', tool: 'npm_lint' },
        { id: 'approve', type: 'approval', prompt: 'Ship?' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const events: string[] = [];
    const result = await executeWorkflowRun(
      'ex_approval',
      compiled.workflow,
      { variables: {} },
      undefined,
      (event) => events.push(event.type),
    );

    expect(result.status).toBe('needs_approval');
    expect(result.requiresApproval?.stepId).toBe('approve');
    expect(result.requiresApproval?.resumeToken).toMatch(/^wrf_rt_/);
    expect(events).toContain('approval.required');
  });

  it('evaluates conditional branches deterministically', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'gate',
          type: 'conditional',
          condition: { variable: 'deploy', equals: true },
          then: [
            { id: 'deploy-step', type: 'tool', tool: 'deploy' },
          ],
          else: [
            { id: 'skip-step', type: 'tool', tool: 'noop' },
          ],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun('ex_conditional', compiled.workflow, {
      variables: { deploy: true },
    });

    expect(result.status).toBe('ok');
    const stepIds = result.steps.map((step) => step.stepId);
    expect(stepIds).toEqual(['gate', 'deploy-step']);
  });

  it('executes bash tool steps and captures stdout', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'echo-step',
          type: 'tool',
          tool: 'bash',
          arguments: {
            command: 'echo workflow-ok',
          },
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun('ex_bash', compiled.workflow, { variables: {} });
    expect(result.status).toBe('ok');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe('completed');
    const output = result.steps[0]?.output as { stdout?: string } | undefined;
    expect(output?.stdout).toContain('workflow-ok');
  });

  it('supports agent_message step hooks', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'notify', type: 'agent_message', content: 'status update' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun(
      'ex_agent_message',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step) => {
          if (step.type !== 'agent_message') return;
          return {
            status: 'completed',
            output: { delivered: true, content: step.content },
          };
        },
      },
    );

    expect(result.status).toBe('ok');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.stepId).toBe('notify');
    expect(result.steps[0]?.status).toBe('completed');
    expect(result.steps[0]?.output).toEqual({ delivered: true, content: 'status update' });
  });

  it('resumes approved checkpoints and continues execution deterministically', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'lint', type: 'tool', tool: 'npm_lint' },
        { id: 'approve', type: 'approval', prompt: 'Ship?' },
        { id: 'deploy', type: 'tool', tool: 'deploy' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const firstRun = await executeWorkflowRun('ex_resume_ok', compiled.workflow, { variables: {} });
    expect(firstRun.status).toBe('needs_approval');
    const resumeToken = firstRun.requiresApproval?.resumeToken;
    if (!resumeToken) {
      throw new Error('missing resume token');
    }

    const events: string[] = [];
    const resumed = await executeWorkflowResume(
      'ex_resume_ok',
      compiled.workflow,
      { variables: {} },
      resumeToken,
      'approve',
      undefined,
      (event) => events.push(event.type),
    );

    expect(resumed.status).toBe('ok');
    expect(resumed.steps.map((step) => step.stepId)).toEqual(['lint', 'approve', 'deploy']);
    expect(resumed.steps.find((step) => step.stepId === 'approve')?.status).toBe('completed');
    expect(events).toContain('approval.approved');
  });

  it('returns cancelled when an approval checkpoint is denied on resume', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'approve', type: 'approval', prompt: 'Ship?' },
        { id: 'deploy', type: 'tool', tool: 'deploy' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const firstRun = await executeWorkflowRun('ex_resume_deny', compiled.workflow, { variables: {} });
    const resumeToken = firstRun.requiresApproval?.resumeToken;
    if (!resumeToken) {
      throw new Error('missing resume token');
    }

    const resumed = await executeWorkflowResume(
      'ex_resume_deny',
      compiled.workflow,
      { variables: {} },
      resumeToken,
      'deny',
    );

    expect(resumed.status).toBe('cancelled');
    expect(resumed.steps.map((step) => step.stepId)).toEqual(['approve']);
    expect(resumed.steps[0]?.status).toBe('cancelled');
  });

  it('supports resuming workflows with multiple approval checkpoints', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'initial_checks', type: 'tool', tool: 'bash', arguments: { command: 'echo checks' } },
        { id: 'first_approval', type: 'approval', prompt: 'Proceed to build?' },
        { id: 'build', type: 'tool', tool: 'bash', arguments: { command: 'echo build' } },
        { id: 'second_approval', type: 'approval', prompt: 'Proceed to deploy?' },
        { id: 'deploy', type: 'tool', tool: 'bash', arguments: { command: 'echo deploy' } },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const firstRun = await executeWorkflowRun('ex_multi_approval', compiled.workflow, { variables: {} });
    expect(firstRun.status).toBe('needs_approval');
    expect(firstRun.requiresApproval?.stepId).toBe('first_approval');

    const firstToken = firstRun.requiresApproval?.resumeToken;
    if (!firstToken) {
      throw new Error('missing first resume token');
    }

    const secondRun = await executeWorkflowResume(
      'ex_multi_approval',
      compiled.workflow,
      { variables: {} },
      firstToken,
      'approve',
    );

    expect(secondRun.status).toBe('needs_approval');
    expect(secondRun.requiresApproval?.stepId).toBe('second_approval');

    const secondToken = secondRun.requiresApproval?.resumeToken;
    if (!secondToken) {
      throw new Error('missing second resume token');
    }

    const thirdRun = await executeWorkflowResume(
      'ex_multi_approval',
      compiled.workflow,
      { variables: {} },
      secondToken,
      'approve',
    );

    expect(thirdRun.status).toBe('ok');
    expect(thirdRun.steps.find((step) => step.stepId === 'first_approval')?.status).toBe('completed');
    expect(thirdRun.steps.find((step) => step.stepId === 'second_approval')?.status).toBe('completed');
  });

  it('fails resume when token does not match the paused checkpoint', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'approve', type: 'approval', prompt: 'Ship?' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const resumed = await executeWorkflowResume(
      'ex_resume_bad_token',
      compiled.workflow,
      { variables: {} },
      'wrf_rt_invalid',
      'approve',
    );

    expect(resumed.status).toBe('failed');
    expect(resumed.error).toMatch(/^resume_token_mismatch:/);
  });
});
