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

  it('interpolates bash command tokens via env vars, not shell splice', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'echo-untrusted',
          type: 'tool',
          tool: 'bash',
          arguments: {
            // Untrusted-looking variable: contains shell metacharacters that
            // would be catastrophic if spliced into the command string.
            command: 'printf %s {{variables.payload}}',
          },
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun('ex_bash_inject', compiled.workflow, {
      variables: { payload: '"; touch /tmp/valet_pwned_$$; echo "owned' },
    });
    expect(result.status).toBe('ok');
    const output = result.steps[0]?.output as { stdout?: string; command?: string } | undefined;
    // The stdout MUST contain the raw payload — proving it was passed as data,
    // not interpreted as shell syntax. The recorded command field should
    // contain the rewritten "$VALET_TPL_0" form, not the raw payload.
    expect(output?.stdout).toContain('"; touch /tmp/valet_pwned_');
    expect(output?.command).toContain('"$VALET_TPL_0"');
    expect(output?.command).not.toContain('touch /tmp/valet_pwned');
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

  it('auto-publishes step output under step id when no outputVariable is set', async () => {
    // Regression: a one-step `agent_prompt` workflow without an explicit
    // `outputVariable` used to vanish from `execution.outputs`, making the
    // UI show "No outputs captured" even though the step completed. The
    // engine now falls back to publishing under `step.id` so users see the
    // result by default.
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'ask', type: 'agent_prompt', prompt: 'What do you do?' },
      ],
    });
    if (!compiled.ok || !compiled.workflow) throw new Error('compile failed');

    const result = await executeWorkflowRun(
      'ex_no_output_var',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async () => ({ status: 'completed', output: 'I am a helpful agent.' }),
      },
    );

    expect(result.status).toBe('ok');
    expect(result.output.ask).toBe('I am a helpful agent.');
  });

  it('respects explicit outputVariable over auto step-id key', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'ask', type: 'agent_prompt', prompt: 'q', outputVariable: 'reply' },
      ],
    });
    if (!compiled.ok || !compiled.workflow) throw new Error('compile failed');

    const result = await executeWorkflowRun(
      'ex_with_output_var',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async () => ({ status: 'completed', output: 'hello' }),
      },
    );

    expect(result.status).toBe('ok');
    expect(result.output.reply).toBe('hello');
    expect(result.output.ask).toBeUndefined();
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

  it('supports agent_prompt step hooks', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'notify', type: 'agent_prompt', prompt: 'status update' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun(
      'ex_agent_prompt',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step) => {
          if (step.type !== 'agent_prompt') return;
          return {
            status: 'completed',
            output: { delivered: true, prompt: step.prompt },
          };
        },
      },
    );

    expect(result.status).toBe('ok');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.stepId).toBe('notify');
    expect(result.steps[0]?.status).toBe('completed');
    expect(result.steps[0]?.output).toEqual({ delivered: true, prompt: 'status update' });
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

  it('emits a distinct envelope entry per loop iteration with iterationPath', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'L1',
          type: 'loop',
          over: 'variables.items',
          steps: [
            { id: 'inner', type: 'tool', tool: 'noop', arguments: { value: '{{loop.item}}' } },
          ],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun(
      'ex_loop_iterpath',
      compiled.workflow,
      { variables: { items: ['a', 'b', 'c'] } },
      {
        onToolStep: async () => ({ status: 'completed', output: { ok: true } }),
      },
    );

    expect(result.status).toBe('ok');
    // The loop itself is a top-level step.
    expect(result.steps.find((s) => s.stepId === 'L1')?.iterationPath).toBe('');
    // Each inner-step entry has its iteration's path.
    const innerSteps = result.steps.filter((s) => s.stepId === 'inner');
    expect(innerSteps).toHaveLength(3);
    expect(innerSteps.map((s) => s.iterationPath)).toEqual(['L1:i0', 'L1:i1', 'L1:i2']);
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

  it('rolls back outputs published by completed iterations when a later iteration fails', async () => {
    // Loop fails on the 3rd iteration ('c'). Without rollback, `outputs.last` would
    // leak the value from iteration 2 ('b'). With rollback, downstream steps see no
    // partial loop state.
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'each',
          type: 'loop',
          over: 'variables.items',
          steps: [
            {
              id: 'visit',
              type: 'tool',
              tool: 'noop',
              arguments: { value: '{{loop.item}}' },
              outputVariable: 'last',
            },
          ],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun(
      'ex_loop_rollback',
      compiled.workflow,
      { variables: { items: ['a', 'b', 'c'] } },
      {
        onToolStep: async (step) => {
          const args = step.arguments as { value?: unknown } | undefined;
          if (args?.value === 'c') {
            return { status: 'failed', error: 'boom' };
          }
          return { status: 'completed', output: { ok: true, item: args?.value } };
        },
      },
    );

    expect(result.status).toBe('failed');
    // outputs.last must be absent — the iterations that ran successfully are rolled back
    // so callers can't observe partial state from a failed loop step.
    const outputs = result.output as Record<string, unknown>;
    expect(outputs).not.toHaveProperty('last');
  });

  it('preserves outputs that existed before the loop when the loop fails', async () => {
    // outputs published BEFORE the loop step must survive a loop failure — only
    // mutations made inside the loop body are rolled back.
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'pre',
          type: 'tool',
          tool: 'noop',
          arguments: { value: 'preloop' },
          outputVariable: 'pre',
        },
        {
          id: 'each',
          type: 'loop',
          over: 'variables.items',
          steps: [
            {
              id: 'visit',
              type: 'tool',
              tool: 'noop',
              arguments: { value: '{{loop.item}}' },
              outputVariable: 'last',
            },
          ],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun(
      'ex_loop_rollback_pre',
      compiled.workflow,
      { variables: { items: ['a', 'b'] } },
      {
        onToolStep: async (step) => {
          const args = step.arguments as { value?: unknown } | undefined;
          if (args?.value === 'b') {
            return { status: 'failed', error: 'boom' };
          }
          return { status: 'completed', output: { ok: true, item: args?.value } };
        },
      },
    );

    expect(result.status).toBe('failed');
    const outputs = result.output as Record<string, unknown>;
    expect(outputs).toHaveProperty('pre');
    expect(outputs).not.toHaveProperty('last');
  });

  it('replays skipped steps from persisted outputs when startFromStepId is set', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'step1',
          type: 'tool',
          tool: 'bash',
          arguments: { command: 'echo first' },
          outputVariable: 'first',
        },
        {
          id: 'step2',
          type: 'tool',
          tool: 'bash',
          arguments: { command: 'echo second' },
          outputVariable: 'second',
        },
        {
          id: 'step3',
          type: 'tool',
          tool: 'bash',
          arguments: { command: 'echo third' },
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    // Baseline run captures outputs we'll feed back as replay data.
    const baseline = await executeWorkflowRun('ex_retry_baseline', compiled.workflow, { variables: {} });
    expect(baseline.status).toBe('ok');
    expect(baseline.steps.map((s) => s.status)).toEqual(['completed', 'completed', 'completed']);

    const replayStepResults: Record<string, { output?: unknown; status?: string }> = {};
    for (const s of baseline.steps) {
      replayStepResults[s.stepId] = { output: s.output, status: s.status };
    }

    const events: { type: string; stepId?: string }[] = [];
    const retried = await executeWorkflowRun(
      'ex_retry_from_step2',
      compiled.workflow,
      {
        variables: {},
        runtime: {
          startFromStepId: 'step2',
          replayOutputs: baseline.output,
          replayStepResults,
        },
      },
      undefined,
      (event) => events.push({
        type: event.type,
        stepId: typeof event.stepId === 'string' ? event.stepId : undefined,
      }),
    );

    expect(retried.status).toBe('ok');
    expect(retried.steps.map((s) => s.stepId)).toEqual(['step1', 'step2', 'step3']);
    expect(retried.steps[0]?.status).toBe('skipped');
    expect(retried.steps[1]?.status).toBe('completed');
    expect(retried.steps[2]?.status).toBe('completed');
    // The replayed step1 output (bash result) should be carried into the skipped row.
    expect(retried.steps[0]?.output).toEqual(baseline.steps[0]?.output);
    // step1's outputVariable should re-populate outputs so {{outputs.first}} would still resolve.
    expect(retried.output.first).toEqual(baseline.output.first);

    const skippedEvents = events.filter((e) => e.type === 'step.skipped');
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0]?.stepId).toBe('step1');
  });

  it('fails with retry_from_step_not_found when target is not at top level', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'gate',
          type: 'conditional',
          condition: 'true',
          then: [
            { id: 'nested-step', type: 'tool', tool: 'bash', arguments: { command: 'echo hi' } },
          ],
        },
        { id: 'after', type: 'tool', tool: 'bash', arguments: { command: 'echo after' } },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun(
      'ex_retry_nested',
      compiled.workflow,
      {
        variables: {},
        runtime: { startFromStepId: 'nested-step', replayOutputs: {}, replayStepResults: {} },
      },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^retry_from_step_not_found:nested-step$/);
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

  it('runs parallel branches concurrently rather than sequentially', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'fanout',
          type: 'parallel',
          steps: [
            { id: 'branch-a', type: 'agent_prompt', prompt: 'a' },
            { id: 'branch-b', type: 'agent_prompt', prompt: 'b' },
          ],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    // Each branch's hook delays before resolving. If branches were sequential,
    // branch-b would not START until branch-a's promise resolved. With true
    // concurrency, b should START before a FINISHES.
    const branchStartedAt = new Map<string, number>();
    const branchFinishedAt = new Map<string, number>();

    const result = await executeWorkflowRun(
      'ex_parallel_concurrent',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step) => {
          if (step.type !== 'agent_prompt') return;
          branchStartedAt.set(step.id, Date.now());
          await new Promise((resolve) => setTimeout(resolve, 80));
          branchFinishedAt.set(step.id, Date.now());
          return { status: 'completed', output: { id: step.id } };
        },
      },
    );

    expect(result.status).toBe('ok');

    const aStart = branchStartedAt.get('branch-a');
    const aEnd = branchFinishedAt.get('branch-a');
    const bStart = branchStartedAt.get('branch-b');
    const bEnd = branchFinishedAt.get('branch-b');

    if (aStart === undefined || aEnd === undefined || bStart === undefined || bEnd === undefined) {
      throw new Error('missing branch timestamps');
    }

    // Whichever branch starts first should still be running when the other starts.
    const firstStart = Math.min(aStart, bStart);
    const firstEnd = aStart === firstStart ? aEnd : bEnd;
    const secondStart = Math.max(aStart, bStart);
    expect(secondStart).toBeLessThan(firstEnd);
  });

  it('returns failed when one parallel branch fails', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'fanout',
          type: 'parallel',
          steps: [
            { id: 'ok', type: 'agent_prompt', prompt: 'fine' },
            { id: 'bad', type: 'agent_prompt', prompt: 'boom' },
          ],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const result = await executeWorkflowRun(
      'ex_parallel_fail',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step) => {
          if (step.id === 'bad') {
            return { status: 'failed', error: 'kaboom' };
          }
          return { status: 'completed', output: { ok: true } };
        },
      },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/kaboom/);
  });

  it('isolates outputs between parallel branches', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'fanout',
          type: 'parallel',
          steps: [
            { id: 'writer', type: 'agent_prompt', prompt: 'write', outputVariable: 'x' },
            { id: 'reader', type: 'agent_prompt', prompt: 'read' },
          ],
        },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    let readerSawX: unknown = 'sentinel';

    const result = await executeWorkflowRun(
      'ex_parallel_iso',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step, ctx) => {
          if (step.id === 'writer') {
            // Delay so the reader has a chance to observe the absence first.
            await new Promise((resolve) => setTimeout(resolve, 40));
            return { status: 'completed', output: 1 };
          }
          if (step.id === 'reader') {
            readerSawX = ctx.outputs.x;
            return { status: 'completed', output: { read: true } };
          }
          return { status: 'completed' };
        },
      },
    );

    expect(result.status).toBe('ok');
    expect(readerSawX).toBeUndefined();
    // After the parallel merges back, the writer's output should be on the parent.
    expect(result.output.x).toBe(1);
  });

  it('propagates cancelled through conditional branches', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'gate',
          type: 'conditional',
          condition: 'true',
          then: [
            { id: 'cancels', type: 'agent_prompt', prompt: 'stop' },
          ],
        },
        { id: 'after', type: 'agent_prompt', prompt: 'should not run' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    let afterRan = false;

    const result = await executeWorkflowRun(
      'ex_cond_cancelled',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step) => {
          if (step.id === 'cancels') {
            return { status: 'cancelled', error: 'user_cancel' };
          }
          if (step.id === 'after') {
            afterRan = true;
          }
          return { status: 'completed' };
        },
      },
    );

    expect(result.status).toBe('cancelled');
    expect(result.error).toMatch(/user_cancel/);
    expect(afterRan).toBe(false);
  });

  it('propagates cancelled through parallel branches', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        {
          id: 'fanout',
          type: 'parallel',
          steps: [
            { id: 'cancels', type: 'agent_prompt', prompt: 'stop' },
            { id: 'sibling', type: 'agent_prompt', prompt: 'ok' },
          ],
        },
        { id: 'after', type: 'agent_prompt', prompt: 'should not run' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    let afterRan = false;

    const result = await executeWorkflowRun(
      'ex_parallel_cancelled',
      compiled.workflow,
      { variables: {} },
      {
        onAgentStep: async (step) => {
          if (step.id === 'cancels') {
            return { status: 'cancelled', error: 'parallel_cancel' };
          }
          if (step.id === 'after') {
            afterRan = true;
          }
          return { status: 'completed' };
        },
      },
    );

    expect(result.status).toBe('cancelled');
    expect(result.error).toMatch(/parallel_cancel/);
    expect(afterRan).toBe(false);
  });

  it('seeds outputs from previousOutputs on resume', async () => {
    const compiled = await compileWorkflowDefinition({
      steps: [
        { id: 'gate', type: 'approval', prompt: 'go?' },
        { id: 'reader', type: 'agent_prompt', prompt: 'check outputs' },
      ],
    });

    if (!compiled.ok || !compiled.workflow) {
      throw new Error('compile failed');
    }

    const firstRun = await executeWorkflowRun('ex_resume_seed', compiled.workflow, { variables: {} });
    const resumeToken = firstRun.requiresApproval?.resumeToken;
    if (!resumeToken) {
      throw new Error('missing resume token');
    }

    let readerSawOutputs: Record<string, unknown> = {};

    const resumed = await executeWorkflowResume(
      'ex_resume_seed',
      compiled.workflow,
      {
        variables: {},
        runtime: { previousOutputs: { upstream: { value: 42 } } },
      },
      resumeToken,
      'approve',
      {
        onAgentStep: async (step, ctx) => {
          if (step.id === 'reader') {
            readerSawOutputs = { ...ctx.outputs };
          }
          return { status: 'completed', output: { ok: true } };
        },
      },
    );

    expect(resumed.status).toBe('ok');
    expect(readerSawOutputs.upstream).toEqual({ value: 42 });
    // The seeded value must survive into the final envelope outputs too.
    expect(resumed.output.upstream).toEqual({ value: 42 });
  });
});
