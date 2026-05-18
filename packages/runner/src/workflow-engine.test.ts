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

  it('routes agent_prompt steps through onAgentStep hook with thread metadata', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'ask-new', type: 'agent_prompt', prompt: 'first question', thread: '@new' },
        { id: 'ask-named-1', type: 'agent_prompt', prompt: 'second question', thread: 'researcher' },
        { id: 'ask-named-2', type: 'agent_prompt', prompt: 'follow up', thread: 'researcher' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    // Simulate the runner's thread-name resolver so we can assert routing decisions
    // without booting OpenCode. This mirrors PromptHandler.resolveWorkflowThreadName.
    const resolveThread = (rawThread: unknown): string => {
      if (typeof rawThread !== 'string' || rawThread.trim() === '') return '__default__';
      const trimmed = rawThread.trim();
      if (trimmed === '@new') return `__new_${crypto.randomUUID()}__`;
      return trimmed;
    };

    const channelIds: string[] = [];
    const result = await executeWorkflowRun(
      'ex_agent_prompt',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step, ctx) => {
          if (step.type !== 'agent_prompt') return;
          const threadName = resolveThread(step.thread);
          const channelId = `${ctx.executionId}:${threadName}`;
          channelIds.push(channelId);
          // Bare-string output to confirm `outputVariable` would capture the reply directly.
          return { status: 'completed', output: `reply to ${step.prompt as string}` };
        },
      },
    );

    expect(result.status).toBe('ok');
    expect(result.steps.map((s) => s.status)).toEqual(['completed', 'completed', 'completed']);
    expect(result.steps[0]?.output).toBe('reply to first question');
    expect(result.steps[1]?.output).toBe('reply to second question');

    // @new yields a unique channel id; named 'researcher' is reused across calls.
    expect(channelIds[0]).toMatch(/:__new_[0-9a-f-]+__$/);
    expect(channelIds[1]).toBe('ex_agent_prompt:researcher');
    expect(channelIds[2]).toBe('ex_agent_prompt:researcher');
    expect(channelIds[0]).not.toBe(channelIds[1]);
  });

  it('surfaces structured-output object as agent_prompt step output', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'extract',
          type: 'agent_prompt',
          prompt: 'Extract fields.',
          outputSchema: {
            summary: { type: 'string' },
            count: { type: 'number' },
          },
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun(
      'ex_struct_ok',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step) => {
          if (step.type !== 'agent_prompt') return;
          // Simulate the runner returning the parsed structured payload
          // (this is what executeWorkflowAgentStep does once parsing succeeds).
          return { status: 'completed', output: { summary: 'hi', count: 3 } };
        },
      },
    );

    expect(result.status).toBe('ok');
    expect(result.steps[0]?.status).toBe('completed');
    expect(result.steps[0]?.output).toEqual({ summary: 'hi', count: 3 });
  });

  it('surfaces structured-output failure from hook', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'extract',
          type: 'agent_prompt',
          prompt: 'Extract fields.',
          outputSchema: { summary: { type: 'string' } },
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun(
      'ex_struct_fail',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step) => {
          if (step.type !== 'agent_prompt') return;
          return {
            status: 'failed',
            error: 'agent_prompt_structured_output_invalid: missing required field "summary"',
          };
        },
      },
    );

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.status).toBe('failed');
    expect(result.steps[0]?.error).toMatch(/agent_prompt_structured_output_invalid/);
  });

  it('rejects agent_prompt with invalid outputSchema at compile time', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'bad',
          type: 'agent_prompt',
          prompt: 'Hi.',
          outputSchema: { x: { type: 'date' } },
        },
      ],
    });

    expect(compiled.ok).toBe(false);
    expect(compiled.errors.some((e) => /type must be one of/.test(e.message))).toBe(true);
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

  it('iterates loop over an array, running body per iteration with loop.item in scope', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'each',
          type: 'loop',
          over: 'variables.items',
          steps: [
            { id: 'visit', type: 'tool', tool: 'noop', arguments: { value: '{{loop.item}}' } },
          ],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const seen: unknown[] = [];
    const result = await executeWorkflowRun(
      'ex_loop_ok',
      compiled.workflow,
      { variables: { items: ['a', 'b', 'c'] } },
      {
        onToolStep: async (step) => {
          const args = step.arguments as { value?: unknown } | undefined;
          seen.push(args?.value);
          return { status: 'completed', output: { ok: true } };
        },
      },
    );

    expect(result.status).toBe('ok');
    expect(seen).toEqual(['a', 'b', 'c']);
    const loopStep = result.steps.find((s) => s.stepId === 'each');
    expect(loopStep?.status).toBe('completed');
    expect(loopStep?.output).toEqual({ iterations: 3 });
  });

  it('fails loop when "over" path resolves to a non-array', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'each',
          type: 'loop',
          over: 'variables.missing',
          steps: [{ id: 'noop', type: 'tool', tool: 'noop' }],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun('ex_loop_bad', compiled.workflow, { variables: {} });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^loop_over_not_array:/);
  });

  it('completes loop with iterations=0 when over is an empty array', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'each',
          type: 'loop',
          over: 'variables.empty',
          steps: [{ id: 'noop', type: 'tool', tool: 'noop' }],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    let calls = 0;
    const result = await executeWorkflowRun(
      'ex_loop_empty',
      compiled.workflow,
      { variables: { empty: [] } },
      {
        onToolStep: async () => {
          calls += 1;
          return { status: 'completed' };
        },
      },
    );
    expect(result.status).toBe('ok');
    expect(calls).toBe(0);
    expect(result.steps.find((s) => s.stepId === 'each')?.output).toEqual({ iterations: 0 });
  });

  it('uses custom itemVar and indexVar identifiers', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'each',
          type: 'loop',
          over: 'variables.users',
          itemVar: 'user',
          indexVar: 'i',
          steps: [
            { id: 'greet', type: 'tool', tool: 'noop', arguments: { greeting: 'hi {{variables.user}} ({{variables.i}})' } },
          ],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const greetings: unknown[] = [];
    const result = await executeWorkflowRun(
      'ex_loop_named',
      compiled.workflow,
      { variables: { users: ['Alice', 'Bob'] } },
      {
        onToolStep: async (step) => {
          const args = step.arguments as { greeting?: unknown } | undefined;
          greetings.push(args?.greeting);
          return { status: 'completed' };
        },
      },
    );
    expect(result.status).toBe('ok');
    expect(greetings).toEqual(['hi Alice (0)', 'hi Bob (1)']);
  });

  it('rejects "agent" and "subworkflow" step types at compile time', async () => {
    const compiledAgent = await compileWorkflowDefinition({
      steps: [{ id: 'a', type: 'agent', goal: 'do thing' }],
    });
    expect(compiledAgent.ok).toBe(false);
    expect(compiledAgent.errors.some((e) => /Unknown step type "agent"/.test(e.message))).toBe(true);

    const compiledSub = await compileWorkflowDefinition({
      steps: [{ id: 's', type: 'subworkflow' }],
    });
    expect(compiledSub.ok).toBe(false);
    expect(compiledSub.errors.some((e) => /Unknown step type "subworkflow"/.test(e.message))).toBe(true);
  });

  it('rejects loop missing "over" at compile time', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'each', type: 'loop', steps: [{ id: 'x', type: 'tool', tool: 'noop' }] },
      ],
    });
    expect(compiled.ok).toBe(false);
    expect(compiled.errors.some((e) => /loop step requires "over"/.test(e.message))).toBe(true);
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
