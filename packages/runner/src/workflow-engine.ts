import type { NormalizedWorkflowDefinition, NormalizedWorkflowStep } from './workflow-compiler.js';
import { evalConditionString } from './workflow-condition.js';
import { resolveBashCommand, resolveInterpolation, resolveStepFields } from './workflow-interpolation.js';

export type WorkflowStatus = 'ok' | 'needs_approval' | 'cancelled' | 'failed';

export interface WorkflowRunPayload {
  trigger?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  runtime?: {
    attempt?: number;
    idempotencyKey?: string;
    policy?: {
      maxSteps?: number;
    };
    /**
     * Retry-from-step support. When set, the engine walks top-level steps in order,
     * emits `step.skipped` events (with persisted output) for each step preceding
     * the target, then resumes normal execution from `startFromStepId` onward.
     * `replayOutputs` seeds `context.outputs` so interpolation can resolve
     * already-published `outputVariable` values from the source execution.
     */
    startFromStepId?: string;
    replayOutputs?: Record<string, unknown>;
    /**
     * Step results from the source execution, keyed by stepId. Used to populate
     * the `output` field on `step.skipped` events so the UI/persistence reflects
     * the original values rather than nulls.
     */
    replayStepResults?: Record<string, { output?: unknown; status?: string }>;
    /**
     * Resume seed: published outputs from the pre-approval portion of the source
     * execution. Used to populate `context.outputs` so that post-approval steps
     * can interpolate values produced by steps the engine no longer re-executes.
     *
     * KNOWN LIMITATION: resume currently re-walks every step from the top of the
     * workflow. Steps before the approval checkpoint will re-fire their hooks
     * (i.e. side effects), then the engine matches the approval token and
     * proceeds. Seeding `previousOutputs` only restores INTERPOLATION fidelity
     * for downstream steps — it does not prevent pre-gate re-execution. A full
     * skip-and-replay (analogous to `startFromStepId`) is the long-term fix.
     */
    previousOutputs?: Record<string, unknown>;
    /**
     * Server-generated random nonce mixed into the approval resume-token
     * derivation. Without it, tokens would be derivable from public values
     * (executionId/stepId/attempt) and attackers could forge approvals.
     * The worker stores the nonce in `runtime_state.approvalNonce` on first
     * dispatch and forwards it on every subsequent run/resume payload.
     */
    approvalNonce?: string;
  };
}

export interface WorkflowStepResult {
  stepId: string;
  status: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface WorkflowRunEnvelope {
  ok: boolean;
  status: WorkflowStatus;
  executionId: string;
  output: Record<string, unknown>;
  steps: WorkflowStepResult[];
  requiresApproval: null | {
    stepId: string;
    prompt: string;
    items: unknown[];
    resumeToken: string;
  };
  error: string | null;
}

export type WorkflowEventType =
  | 'execution.started'
  | 'execution.finished'
  | 'execution.resumed'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'step.skipped'
  | 'step.cancelled'
  | 'approval.required'
  | 'approval.approved'
  | 'approval.denied';

export interface WorkflowEvent {
  type: WorkflowEventType;
  executionId: string;
  ts: string;
  [key: string]: unknown;
}

export interface WorkflowStepExecutionContext {
  executionId: string;
  attempt: number;
  variables: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

export interface WorkflowStepExecutionResult {
  status?: 'completed' | 'failed' | 'cancelled';
  output?: unknown;
  error?: string;
}

export interface WorkflowExecutionHooks {
  onToolStep?: (step: NormalizedWorkflowStep, context: WorkflowStepExecutionContext) => Promise<WorkflowStepExecutionResult | void>;
  onAgentStep?: (step: NormalizedWorkflowStep, context: WorkflowStepExecutionContext) => Promise<WorkflowStepExecutionResult | void>;
  onNotifyStep?: (step: NormalizedWorkflowStep, context: WorkflowStepExecutionContext) => Promise<WorkflowStepExecutionResult | void>;
}

export type EventSink = (event: WorkflowEvent) => void;
type ResumeDecision = 'approve' | 'deny';
type ExecuteStepsResult = {
  approval?: WorkflowRunEnvelope['requiresApproval'];
  failed?: string;
  cancelled?: string;
};
type ResumeContext = {
  resumeToken: string;
  decision: ResumeDecision;
  matched: boolean;
  mismatchStepId?: string;
};

type ReplayContext = {
  /** Stop skipping (and run normally) once we hit this top-level stepId. */
  targetStepId: string;
  /** Per-stepId step result from the source execution (for output backfill). */
  results: Record<string, { output?: unknown; status?: string }>;
  /** Flips false once `targetStepId` has been observed at top-level. */
  skipping: boolean;
  /** True once we've actually seen the target — used to detect a missing target. */
  targetFound: boolean;
};

type ExecutionContext = {
  executionId: string;
  attempt: number;
  variables: Record<string, unknown>;
  outputs: Record<string, unknown>;
  steps: WorkflowStepResult[];
  maxSteps: number;
  visitedSteps: number;
  resume?: ResumeContext;
  hooks?: WorkflowExecutionHooks;
  replay?: ReplayContext;
  /** See WorkflowRunPayload.runtime.approvalNonce. */
  approvalNonce?: string;
};

const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 64_000;

function nowIso(): string {
  return new Date().toISOString();
}

function emit(sink: EventSink | undefined, event: WorkflowEvent): void {
  if (!sink) return;
  sink(event);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function asStepArray(value: unknown): NormalizedWorkflowStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is NormalizedWorkflowStep => !!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string')
    .sort((a, b) => a.id.localeCompare(b.id));
}

function resolveLoopArray(path: string, ctx: ExecutionContext): unknown {
  const segs = path.split('.');
  const root = segs.shift();
  const source = root === 'variables' ? ctx.variables : root === 'outputs' ? ctx.outputs : null;
  if (!source) return null;
  let cursor: unknown = source;
  for (const s of segs) {
    if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      cursor = (cursor as Record<string, unknown>)[s];
    } else {
      return null;
    }
  }
  return cursor;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function truncateText(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

/**
 * Execute a bash tool step.
 *
 * SECURITY MODEL — interpolation in bash commands:
 *
 * Unlike other step types, the bash `command` field is NOT pre-interpolated
 * by `resolveStepFields` at the caller. Naively splicing `{{variables.x}}`
 * into a shell string would let an attacker-controlled webhook payload inject
 * shell metacharacters (`; rm -rf /`, backticks, `$(...)`, etc.).
 *
 * Instead, the caller (`executeStepAction`) rewrites each `{{path}}` token in
 * the raw command into a shell variable reference (`"$VALET_TPL_N"`) and
 * passes the resolved values via the process `env` map. The shell then
 * expands the variable as a single token — no parsing, no injection.
 *
 * Workflow authors quote tokens themselves (`"$VAR"`) for safety in arbitrary
 * positions. The LLM drafter is taught the same convention in
 * `workflow-draft.ts:SYSTEM_PROMPT`.
 */
async function executeBashToolStep(
  step: NormalizedWorkflowStep,
  extraEnv?: Record<string, string>,
): Promise<WorkflowStepExecutionResult> {
  const args = asRecord(step.arguments);
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) {
    return {
      status: 'failed',
      error: 'workflow_tool_bash_missing_command',
      output: { tool: 'bash', arguments: args },
    };
  }

  const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
  const timeoutRaw = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_BASH_TIMEOUT_MS;
  const timeoutMs = Math.max(1_000, Math.min(timeoutRaw, 600_000));
  const started = Date.now();

  const proc = Bun.spawn(['bash', '-lc', command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: extraEnv ? { ...process.env, ...extraEnv } : (process.env as Record<string, string>),
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // ignore kill errors
    }
  }, timeoutMs);

  const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  const stdout = truncateText(stdoutRaw || '');
  const stderr = truncateText(stderrRaw || '');
  const durationMs = Date.now() - started;
  const output = {
    tool: 'bash',
    command,
    cwd: cwd || process.cwd(),
    timeoutMs,
    durationMs,
    exitCode,
    stdout,
    stderr,
  };

  if (timedOut) {
    return {
      status: 'failed',
      error: `bash_timeout:${timeoutMs}`,
      output,
    };
  }

  if (exitCode !== 0) {
    return {
      status: 'failed',
      error: `bash_exit_code:${exitCode}`,
      output,
    };
  }

  return { status: 'completed', output };
}

function executeBashStep(
  step: NormalizedWorkflowStep,
  extraEnv?: Record<string, string>,
): Promise<WorkflowStepExecutionResult> {
  const command = typeof step.command === 'string' ? step.command.trim() : '';
  if (!command) {
    return Promise.resolve({
      status: 'failed',
      error: 'bash_missing_command',
      output: { type: 'bash' },
    });
  }

  const cwd = typeof step.cwd === 'string' && step.cwd.trim() ? step.cwd.trim() : undefined;
  const timeoutRaw = typeof step.timeoutMs === 'number' ? step.timeoutMs : DEFAULT_BASH_TIMEOUT_MS;
  // Reuse the existing executeBashToolStep by wrapping into the tool step shape.
  // `step.command` is the already-rewritten, interpolated-as-env-vars version.
  const toolStep: NormalizedWorkflowStep = {
    ...step,
    type: 'tool',
    tool: 'bash',
    arguments: { command, cwd, timeoutMs: timeoutRaw },
  };
  return executeBashToolStep(toolStep, extraEnv);
}

async function executeStepAction(rawStep: NormalizedWorkflowStep, ctx: ExecutionContext): Promise<WorkflowStepExecutionResult> {
  const context: WorkflowStepExecutionContext = {
    executionId: ctx.executionId,
    attempt: ctx.attempt,
    variables: ctx.variables,
    outputs: ctx.outputs,
  };

  // Resolve {{variables.x}} and {{outputs.y.z}} tokens in user-authored string fields
  // before each step executes. Missing paths warn but don't fail the step.
  const { step: resolved, missingPaths } = resolveStepFields(rawStep as Record<string, unknown>, {
    variables: ctx.variables,
    outputs: ctx.outputs,
  });
  if (missingPaths.length > 0) {
    console.warn(
      `[workflow-engine] step ${rawStep.id} has unresolved interpolation paths: ${missingPaths.join(', ')}`,
    );
  }
  const step = resolved as NormalizedWorkflowStep;

  if (step.type === 'bash') {
    // resolveStepFields skips `command` for bash steps — rewrite tokens to env
    // vars here so untrusted values can't inject shell metacharacters. See
    // `executeBashToolStep` for the full security model writeup.
    const rawCommand = typeof rawStep.command === 'string' ? rawStep.command : '';
    const interp = resolveBashCommand(rawCommand, {
      variables: ctx.variables,
      outputs: ctx.outputs,
    });
    if (interp.missingPaths.length > 0) {
      console.warn(
        `[workflow-engine] bash step ${rawStep.id} has unresolved interpolation paths: ${interp.missingPaths.join(', ')}`,
      );
    }
    const stepWithSafeCommand: NormalizedWorkflowStep = { ...step, command: interp.command };
    return executeBashStep(stepWithSafeCommand, interp.env);
  }

  if (step.type === 'notify') {
    if (ctx.hooks?.onNotifyStep) {
      const hooked = await ctx.hooks.onNotifyStep(step, context);
      if (hooked) return hooked;
    }
    return {
      status: 'completed',
      output: {
        type: 'notify',
        target: typeof step.target === 'string' ? step.target : 'orchestrator',
        delivered: false,
      },
    };
  }

  if (step.type === 'tool') {
    if (ctx.hooks?.onToolStep) {
      const hooked = await ctx.hooks.onToolStep(step, context);
      if (hooked) return hooked;
    }

    if (step.tool === 'bash') {
      // Same security treatment as `type: bash` — rewrite `{{path}}` tokens in
      // arguments.command into `"$VALET_TPL_N"` and pass values via env.
      const rawArgs = asRecord(rawStep.arguments);
      const rawCommand = typeof rawArgs.command === 'string' ? rawArgs.command : '';
      const interp = resolveBashCommand(rawCommand, {
        variables: ctx.variables,
        outputs: ctx.outputs,
      });
      if (interp.missingPaths.length > 0) {
        console.warn(
          `[workflow-engine] bash tool step ${rawStep.id} has unresolved interpolation paths: ${interp.missingPaths.join(', ')}`,
        );
      }
      const mergedArgs = { ...asRecord(step.arguments), command: interp.command };
      const stepWithSafeArgs: NormalizedWorkflowStep = { ...step, arguments: mergedArgs };
      return executeBashToolStep(stepWithSafeArgs, interp.env);
    }

    return {
      status: 'completed',
      output: {
        type: step.type,
        name: typeof step.name === 'string' ? step.name : step.id,
        tool: step.tool ?? null,
        arguments: step.arguments ?? null,
      },
    };
  }

  if (step.type === 'agent_prompt') {
    if (ctx.hooks?.onAgentStep) {
      const hooked = await ctx.hooks.onAgentStep(step, context);
      if (hooked) return hooked;
    }

    return {
      status: 'completed',
      output: {
        type: step.type,
        name: typeof step.name === 'string' ? step.name : step.id,
        goal: step.goal ?? null,
        context: step.context ?? null,
      },
    };
  }

  return {
    status: 'completed',
    output: {
      type: step.type,
      name: typeof step.name === 'string' ? step.name : step.id,
    },
  };
}

function evaluateCondition(step: NormalizedWorkflowStep, ctx: ExecutionContext): boolean {
  const condition = step.condition;
  if (typeof condition === 'boolean') return condition;
  if (typeof condition === 'string' && condition.trim()) {
    // Loop bodies stash a `{ item, index }` record under `variables.loop` — expose it as a
    // first-class namespace so authors can write `loop.item` in conditions.
    const loopValue = ctx.variables.loop;
    const loopCtx = loopValue && typeof loopValue === 'object' && !Array.isArray(loopValue)
      ? (loopValue as Record<string, unknown>)
      : undefined;
    // `evaluateCondition` runs BEFORE `executeStepAction`, so `resolveStepFields` has not
    // touched the raw condition string yet. Resolve `{{...}}` tokens here so authors can
    // mix templated values (`{{variables.flag}} === "done"`) with raw paths
    // (`outputs.list_runs.failed > 0`). The condition parser only understands raw paths.
    const resolved = resolveInterpolation(condition, {
      variables: ctx.variables,
      outputs: ctx.outputs,
    });
    if (resolved.missingPaths.length > 0) {
      console.warn(`[workflow-engine] condition for ${step.id} has unresolved paths: ${resolved.missingPaths.join(', ')}`);
    }
    return evalConditionString(resolved.text, {
      variables: ctx.variables,
      outputs: ctx.outputs,
      loop: loopCtx,
    });
  }
  // Legacy `{ variable, equals }` shape — kept for backward compatibility with old drafts.
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    const conditionObj = condition as Record<string, unknown>;
    const variableName = conditionObj.variable;
    if (typeof variableName === 'string') {
      const current = ctx.variables[variableName] ?? ctx.outputs[variableName];
      if (Object.prototype.hasOwnProperty.call(conditionObj, 'equals')) {
        return current === conditionObj.equals;
      }
      return Boolean(current);
    }
  }

  return false;
}

function stepOutputVariable(step: NormalizedWorkflowStep): string | null {
  const value = step.outputVariable;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function buildStepInput(step: NormalizedWorkflowStep): Record<string, unknown> {
  const input: Record<string, unknown> = {
    type: step.type,
    name: typeof step.name === 'string' ? step.name : step.id,
  };
  if (step.tool) input.tool = step.tool;
  if (typeof step.command === 'string') input.command = step.command;
  if (step.goal) input.goal = step.goal;
  if (step.context) input.context = step.context;
  if (typeof step.prompt === 'string') input.prompt = step.prompt;
  if (step.condition !== undefined) input.condition = step.condition;
  if (step.arguments) input.arguments = step.arguments;
  return input;
}

/**
 * Compute the resume token for an approval step.
 *
 * SECURITY: The token MUST NOT be derivable from public values (executionId,
 * stepId, attempt) alone — any caller with read access to executions could
 * forge an approval. The `approvalNonce` is a server-generated random string
 * persisted to `runtime_state.approvalNonce` when the worker first dispatches
 * the execution. It is never returned to clients. The runner receives it on
 * both initial run and resume via `payload.runtime.approvalNonce`.
 *
 * If `approvalNonce` is missing (legacy executions created before this fix
 * was deployed), we fall back to the old deterministic derivation so
 * in-flight workflows can still complete. New executions always carry the
 * nonce because the worker generates one on first enqueue.
 */
function createApprovalToken(
  executionId: string,
  stepId: string,
  attempt: number,
  approvalNonce: string | undefined,
): Promise<string> {
  const seed = approvalNonce
    ? `${executionId}:${stepId}:${attempt}:${approvalNonce}`
    : `${executionId}:${stepId}:${attempt}`;
  return sha256Hex(seed).then((digest) => `wrf_rt_${digest.slice(0, 24)}`);
}

async function executeSteps(
  steps: NormalizedWorkflowStep[],
  ctx: ExecutionContext,
  sink: EventSink | undefined,
  replay?: ReplayContext,
): Promise<ExecuteStepsResult> {
  for (const step of steps) {
    if (ctx.visitedSteps >= ctx.maxSteps) {
      return { failed: `max_steps_exceeded:${ctx.maxSteps}` };
    }

    ctx.visitedSteps += 1;

    // Retry-from-step: skip top-level steps until we hit the target.
    // We mark the target as found before falling through to normal execution.
    if (replay && replay.skipping) {
      if (step.id === replay.targetStepId) {
        replay.skipping = false;
        replay.targetFound = true;
      } else {
        const ts = nowIso();
        const prior = replay.results[step.id];
        const replayedOutput = prior?.output ?? null;
        // Replicate `outputVariable` publication for skipped steps so downstream
        // interpolation sees the same values as the original run.
        const outputVar = stepOutputVariable(step);
        if (outputVar) {
          ctx.outputs[outputVar] = replayedOutput;
        } else if (replayedOutput !== undefined && replayedOutput !== null) {
          // Mirror the auto-publish-under-step.id fallback used on the live
          // execution path so retry-from-step preserves the same outputs map
          // shape that the original run produced.
          ctx.outputs[step.id] = replayedOutput;
        }
        ctx.steps.push({
          stepId: step.id,
          status: 'skipped',
          attempt: ctx.attempt,
          startedAt: ts,
          completedAt: ts,
          input: buildStepInput(step),
          output: replayedOutput,
        });
        emit(sink, {
          type: 'step.skipped',
          executionId: ctx.executionId,
          stepId: step.id,
          attempt: ctx.attempt,
          output: replayedOutput,
          ts,
        });
        continue;
      }
    }

    const startedAt = nowIso();
    const result: WorkflowStepResult = {
      stepId: step.id,
      status: 'running',
      attempt: ctx.attempt,
      startedAt,
      input: buildStepInput(step),
    };

    ctx.steps.push(result);
    emit(sink, { type: 'step.started', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: startedAt });

    if (step.type === 'approval') {
      const prompt = typeof step.prompt === 'string' && step.prompt.trim()
        ? step.prompt.trim()
        : `Approval required for step ${step.id}`;
      const resumeToken = await createApprovalToken(ctx.executionId, step.id, ctx.attempt, ctx.approvalNonce);
      const stepTs = nowIso();

      if (ctx.resume && !ctx.resume.matched) {
        if (ctx.resume.resumeToken !== resumeToken) {
          // Resume replays from the beginning. Non-matching approvals before the target
          // checkpoint are treated as already-approved and execution continues.
          ctx.resume.mismatchStepId ||= step.id;
          result.status = 'completed';
          result.completedAt = stepTs;
          result.output = { prompt, decision: 'approve', replayed: true };
          emit(sink, { type: 'step.completed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: stepTs });
          continue;
        }

        ctx.resume.matched = true;
        if (ctx.resume.decision === 'deny') {
          result.status = 'cancelled';
          result.completedAt = stepTs;
          result.error = 'approval_denied';
          result.output = { prompt, decision: 'deny' };

          emit(sink, {
            type: 'approval.denied',
            executionId: ctx.executionId,
            stepId: step.id,
            attempt: ctx.attempt,
            resumeToken,
            ts: stepTs,
          });
          emit(sink, {
            type: 'step.cancelled',
            executionId: ctx.executionId,
            stepId: step.id,
            attempt: ctx.attempt,
            reason: 'approval_denied',
            ts: stepTs,
          });

          return { cancelled: 'approval_denied' };
        }

        result.status = 'completed';
        result.completedAt = stepTs;
        result.output = { prompt, decision: 'approve' };

        emit(sink, {
          type: 'approval.approved',
          executionId: ctx.executionId,
          stepId: step.id,
          attempt: ctx.attempt,
          resumeToken,
          ts: stepTs,
        });
        emit(sink, { type: 'step.completed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: stepTs });
        continue;
      }

      result.status = 'waiting_approval';
      result.completedAt = stepTs;
      result.output = { prompt };

      emit(sink, {
        type: 'approval.required',
        executionId: ctx.executionId,
        stepId: step.id,
        attempt: ctx.attempt,
        resumeToken,
        ts: stepTs,
      });

      return {
        approval: {
          stepId: step.id,
          prompt,
          items: [],
          resumeToken,
        },
      };
    }

    if (step.type === 'loop') {
      const overPath = typeof step.over === 'string' ? step.over.trim() : '';
      if (!overPath) {
        result.status = 'failed';
        result.error = 'loop_missing_over';
        result.completedAt = nowIso();
        emit(sink, { type: 'step.failed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: result.completedAt, error: result.error });
        return { failed: result.error };
      }
      const items = resolveLoopArray(overPath, ctx);
      if (!Array.isArray(items)) {
        result.status = 'failed';
        result.error = `loop_over_not_array: ${overPath}`;
        result.completedAt = nowIso();
        emit(sink, { type: 'step.failed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: result.completedAt, error: result.error });
        return { failed: result.error };
      }
      const itemVar = typeof step.itemVar === 'string' && step.itemVar ? step.itemVar : 'item';
      const indexVar = typeof step.indexVar === 'string' && step.indexVar ? step.indexVar : 'index';
      const body = asStepArray(step.steps);

      // Snapshot outputs at loop entry so a mid-loop failure rolls back partial
      // mutations from completed iterations. Without this, downstream steps after
      // a failed loop step would observe stale `outputVariable` values from
      // whichever iterations happened to run before the failure — predictable
      // strict semantics are preferable to surfacing partial state to retries.
      const loopOutputsBefore = { ...ctx.outputs };
      let lastChildRun: ExecuteStepsResult = {};
      for (let i = 0; i < items.length; i++) {
        // Shadow user-named variables and publish a `loop` namespace so
        // {{loop.item}} / {{loop.index}} resolve during interpolation; restore
        // after each iteration so outer scope isn't polluted.
        const savedItem = ctx.variables[itemVar];
        const savedIndex = ctx.variables[indexVar];
        const savedLoop = ctx.variables['loop'];
        ctx.variables[itemVar] = items[i];
        ctx.variables[indexVar] = i;
        ctx.variables['loop'] = { item: items[i], index: i };
        try {
          lastChildRun = await executeSteps(body, ctx, sink);
          if (lastChildRun.approval || lastChildRun.failed || lastChildRun.cancelled) {
            ctx.variables[itemVar] = savedItem;
            ctx.variables[indexVar] = savedIndex;
            ctx.variables['loop'] = savedLoop;
            if (lastChildRun.failed) {
              // Mutate in place so the same object reference held elsewhere
              // (e.g. returned as `output: context.outputs`) stays valid.
              for (const key of Object.keys(ctx.outputs)) {
                if (!(key in loopOutputsBefore)) delete ctx.outputs[key];
              }
              for (const [key, value] of Object.entries(loopOutputsBefore)) {
                ctx.outputs[key] = value;
              }
            }
            return lastChildRun;
          }
        } finally {
          ctx.variables[itemVar] = savedItem;
          ctx.variables[indexVar] = savedIndex;
          ctx.variables['loop'] = savedLoop;
        }
      }

      const completedAt = nowIso();
      result.status = 'completed';
      result.completedAt = completedAt;
      result.output = { iterations: items.length };
      emit(sink, { type: 'step.completed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: completedAt });
      continue;
    }

    if (step.type === 'conditional') {
      const conditionResult = evaluateCondition(step, ctx);
      const branchSteps = conditionResult ? asStepArray(step.then) : asStepArray(step.else);
      const branchRun = await executeSteps(branchSteps, ctx, sink);

      const completedAt = nowIso();
      result.status = 'completed';
      result.completedAt = completedAt;
      result.output = {
        condition: conditionResult,
        branch: conditionResult ? 'then' : 'else',
      };

      emit(sink, { type: 'step.completed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: completedAt });

      // Propagate cancelled in addition to approval/failed — previously dropped,
      // which let the parent walk continue past a cancelled child branch.
      if (branchRun.approval || branchRun.failed || branchRun.cancelled) return branchRun;
      continue;
    }

    if (step.type === 'parallel') {
      const branches = asStepArray(step.steps);
      // Snapshot outputs/variables at parallel entry. Each branch builds on this
      // snapshot independently — sibling branches must not see each other's
      // outputs (or mutate each other's variables) during concurrent execution.
      const outputsAtEntry = { ...ctx.outputs };
      const variablesAtEntry = { ...ctx.variables };

      const branchResults = await Promise.all(
        branches.map(async (branchStep) => {
          const branchCtx: ExecutionContext = {
            ...ctx,
            outputs: { ...outputsAtEntry },
            variables: { ...variablesAtEntry },
            // Step records still flow into the shared list so the envelope's
            // `steps` array contains every executed step regardless of branch.
            steps: ctx.steps,
          };
          const branchRun = await executeSteps([branchStep], branchCtx, sink);
          return { branchRun, branchCtx };
        }),
      );

      // Merge each branch's NEW outputs back into the parent context. Keys that
      // already existed at entry are skipped to avoid clobbering with stale
      // snapshots; for keys produced inside the branches, last writer wins on
      // collision (use distinct outputVariables across branches to avoid this).
      for (const { branchCtx } of branchResults) {
        for (const [k, v] of Object.entries(branchCtx.outputs)) {
          if (!(k in outputsAtEntry)) ctx.outputs[k] = v;
        }
      }

      const completedAt = nowIso();
      result.status = 'completed';
      result.completedAt = completedAt;
      result.output = { branchCount: branches.length };

      // Surface the first non-clean status from any branch. Priority order:
      // failed > cancelled > approval — failure is the most actionable, and
      // we want the engine to stop walking siblings if any branch errored.
      const failed = branchResults.find((r) => r.branchRun.failed);
      if (failed) {
        emit(sink, { type: 'step.failed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: completedAt, error: failed.branchRun.failed });
        return { failed: failed.branchRun.failed };
      }
      const cancelled = branchResults.find((r) => r.branchRun.cancelled);
      if (cancelled) {
        emit(sink, { type: 'step.cancelled', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: completedAt, reason: cancelled.branchRun.cancelled });
        return { cancelled: cancelled.branchRun.cancelled };
      }
      const approval = branchResults.find((r) => r.branchRun.approval);
      if (approval) {
        return { approval: approval.branchRun.approval };
      }

      emit(sink, { type: 'step.completed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: completedAt });
      continue;
    }

    try {
      const stepOut = await executeStepAction(step, ctx);
      const status = stepOut.status || 'completed';

      const completedAt = nowIso();
      result.status = status;
      result.completedAt = completedAt;
      result.output = stepOut.output;
      if (stepOut.error) {
        result.error = stepOut.error;
      }

      if (status === 'failed') {
        throw new Error(stepOut.error || `step_failed:${step.id}`);
      }

      if (status === 'cancelled') {
        emit(sink, {
          type: 'step.cancelled',
          executionId: ctx.executionId,
          stepId: step.id,
          attempt: ctx.attempt,
          reason: stepOut.error || 'cancelled',
          ts: completedAt,
        });
        return { cancelled: stepOut.error || 'cancelled' };
      }

      const outputVar = stepOutputVariable(step);
      if (outputVar) {
        ctx.outputs[outputVar] = stepOut.output ?? null;
      } else if (stepOut.output !== undefined && stepOut.output !== null) {
        // Steps without an explicit `outputVariable` would otherwise produce
        // no entry in the execution's outputs map — making the UI show
        // "No outputs captured" even when a step returned content (e.g. a
        // single-step `agent_prompt` workflow). Publish under the step id so
        // the result is at least visible. Explicit `outputVariable` still
        // wins and keeps the existing downstream interpolation contract;
        // these auto-keys are purely visibility helpers and shouldn't be
        // relied on for `${outputs.*}` references in user-authored steps.
        ctx.outputs[step.id] = stepOut.output;
      }

      emit(sink, { type: 'step.completed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: completedAt });
    } catch (error) {
      const completedAt = nowIso();
      const message = error instanceof Error ? error.message : String(error);
      result.status = 'failed';
      result.error = message;
      result.completedAt = completedAt;

      emit(sink, {
        type: 'step.failed',
        executionId: ctx.executionId,
        stepId: step.id,
        attempt: ctx.attempt,
        error: message,
        ts: completedAt,
      });

      return { failed: message };
    }
  }

  return {};
}

export async function executeWorkflowRun(
  executionId: string,
  workflow: NormalizedWorkflowDefinition,
  payload: WorkflowRunPayload,
  hooks?: WorkflowExecutionHooks,
  sink?: EventSink,
): Promise<WorkflowRunEnvelope> {
  const startedAt = nowIso();
  const attempt = payload.runtime?.attempt && payload.runtime.attempt > 0 ? payload.runtime.attempt : 1;
  const maxSteps = payload.runtime?.policy?.maxSteps && payload.runtime.policy.maxSteps > 0
    ? payload.runtime.policy.maxSteps
    : 50;

  emit(sink, { type: 'execution.started', executionId, ts: startedAt });

  const replayOutputs = payload.runtime?.replayOutputs;
  const startFromStepId = typeof payload.runtime?.startFromStepId === 'string'
    ? payload.runtime.startFromStepId.trim()
    : '';
  const replayStepResults = payload.runtime?.replayStepResults || {};

  const context: ExecutionContext = {
    executionId,
    attempt,
    variables: { ...(payload.variables || {}) },
    // Seed outputs with the source execution's persisted outputs so downstream
    // steps' interpolation (e.g. {{outputs.foo.bar}}) resolves against the
    // original successful values when retrying.
    outputs: { ...(replayOutputs || {}) },
    steps: [],
    maxSteps,
    visitedSteps: 0,
    hooks,
    approvalNonce: payload.runtime?.approvalNonce,
  };

  const replay: ReplayContext | undefined = startFromStepId
    ? {
        targetStepId: startFromStepId,
        results: replayStepResults,
        skipping: true,
        targetFound: false,
      }
    : undefined;

  const run = await executeSteps(workflow.steps || [], context, sink, replay);

  // Defensive: top-level walk completed and the target was never hit. The worker
  // validation layer should have rejected nested targets, but if we get here
  // surface a clear error rather than silently completing a no-op replay.
  if (replay && !replay.targetFound) {
    const finishedAt = nowIso();
    const error = `retry_from_step_not_found:${replay.targetStepId}`;
    emit(sink, { type: 'execution.finished', executionId, status: 'failed', ts: finishedAt, error });
    return {
      ok: false,
      status: 'failed',
      executionId,
      output: context.outputs,
      steps: context.steps,
      requiresApproval: null,
      error,
    };
  }

  if (run.cancelled) {
    const finishedAt = nowIso();
    emit(sink, { type: 'execution.finished', executionId, status: 'cancelled', ts: finishedAt });
    return {
      ok: true,
      status: 'cancelled',
      executionId,
      output: context.outputs,
      steps: context.steps,
      requiresApproval: null,
      error: run.cancelled,
    };
  }

  if (run.approval) {
    const finishedAt = nowIso();
    emit(sink, { type: 'execution.finished', executionId, status: 'needs_approval', ts: finishedAt });
    return {
      ok: true,
      status: 'needs_approval',
      executionId,
      output: context.outputs,
      steps: context.steps,
      requiresApproval: run.approval,
      error: null,
    };
  }

  if (run.failed) {
    const finishedAt = nowIso();
    emit(sink, { type: 'execution.finished', executionId, status: 'failed', ts: finishedAt });
    return {
      ok: false,
      status: 'failed',
      executionId,
      output: context.outputs,
      steps: context.steps,
      requiresApproval: null,
      error: run.failed,
    };
  }

  const finishedAt = nowIso();
  emit(sink, { type: 'execution.finished', executionId, status: 'ok', ts: finishedAt });
  return {
    ok: true,
    status: 'ok',
    executionId,
    output: context.outputs,
    steps: context.steps,
    requiresApproval: null,
    error: null,
  };
}

export async function executeWorkflowResume(
  executionId: string,
  workflow: NormalizedWorkflowDefinition,
  payload: WorkflowRunPayload,
  resumeToken: string,
  decision: ResumeDecision,
  hooks?: WorkflowExecutionHooks,
  sink?: EventSink,
): Promise<WorkflowRunEnvelope> {
  const startedAt = nowIso();
  const attempt = payload.runtime?.attempt && payload.runtime.attempt > 0 ? payload.runtime.attempt : 1;
  const maxSteps = payload.runtime?.policy?.maxSteps && payload.runtime.policy.maxSteps > 0
    ? payload.runtime.policy.maxSteps
    : 50;

  emit(sink, { type: 'execution.resumed', executionId, decision, ts: startedAt });

  const context: ExecutionContext = {
    executionId,
    attempt,
    variables: { ...(payload.variables || {}) },
    // Seed outputs from the source execution so steps after the approval gate
    // can still interpolate `{{outputs.foo}}` for values published before the
    // pause. Pre-gate steps will still re-execute (and may overwrite these
    // entries) — see the `previousOutputs` doc comment for the known limitation.
    outputs: { ...(payload.runtime?.previousOutputs || {}) },
    steps: [],
    maxSteps,
    visitedSteps: 0,
    hooks,
    approvalNonce: payload.runtime?.approvalNonce,
    resume: {
      resumeToken,
      decision,
      matched: false,
    },
  };

  const run = await executeSteps(workflow.steps || [], context, sink);

  if (run.failed) {
    const finishedAt = nowIso();
    emit(sink, { type: 'execution.finished', executionId, status: 'failed', ts: finishedAt });
    return {
      ok: false,
      status: 'failed',
      executionId,
      output: context.outputs,
      steps: context.steps,
      requiresApproval: null,
      error: run.failed,
    };
  }

  if (!context.resume?.matched) {
    const finishedAt = nowIso();
    const mismatch = context.resume?.mismatchStepId
      ? `resume_token_mismatch:${context.resume.mismatchStepId}`
      : 'resume_token_not_found';
    emit(sink, { type: 'execution.finished', executionId, status: 'failed', ts: finishedAt, error: mismatch });
    return {
      ok: false,
      status: 'failed',
      executionId,
      output: context.outputs,
      steps: context.steps,
      requiresApproval: null,
      error: mismatch,
    };
  }

  if (run.cancelled) {
    const finishedAt = nowIso();
    emit(sink, { type: 'execution.finished', executionId, status: 'cancelled', ts: finishedAt });
    return {
      ok: true,
      status: 'cancelled',
      executionId,
      output: context.outputs,
      steps: context.steps,
      requiresApproval: null,
      error: run.cancelled,
    };
  }

  if (run.approval) {
    const finishedAt = nowIso();
    emit(sink, { type: 'execution.finished', executionId, status: 'needs_approval', ts: finishedAt });
    return {
      ok: true,
      status: 'needs_approval',
      executionId,
      output: context.outputs,
      steps: context.steps,
      requiresApproval: run.approval,
      error: null,
    };
  }

  const finishedAt = nowIso();
  emit(sink, { type: 'execution.finished', executionId, status: 'ok', ts: finishedAt });
  return {
    ok: true,
    status: 'ok',
    executionId,
    output: context.outputs,
    steps: context.steps,
    requiresApproval: null,
    error: null,
  };
}
