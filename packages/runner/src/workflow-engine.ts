import type { NormalizedWorkflowDefinition, NormalizedWorkflowStep } from './workflow-compiler.js';
import { resolveStepFields } from './workflow-interpolation.js';

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function truncateText(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

async function executeBashToolStep(step: NormalizedWorkflowStep): Promise<WorkflowStepExecutionResult> {
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

function executeBashStep(step: NormalizedWorkflowStep): Promise<WorkflowStepExecutionResult> {
  const command = typeof step.command === 'string' ? step.command.trim() : '';
  if (!command) {
    return Promise.resolve({
      status: 'failed',
      error: 'bash_missing_command',
      output: { type: 'bash' },
    });
  }

  const cwd = typeof step.cwd === 'string' && (step.cwd as string).trim() ? (step.cwd as string).trim() : undefined;
  const timeoutRaw = typeof step.timeoutMs === 'number' ? step.timeoutMs as number : DEFAULT_BASH_TIMEOUT_MS;
  // Reuse the existing executeBashToolStep by wrapping into the tool step shape
  const toolStep = { ...step, type: 'tool', tool: 'bash', arguments: { command, cwd, timeoutMs: timeoutRaw } } as NormalizedWorkflowStep;
  return executeBashToolStep(toolStep);
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
    return executeBashStep(step);
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
      return executeBashToolStep(step);
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

  if (step.type === 'agent' || step.type === 'agent_message' || step.type === 'agent_prompt') {
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

function createApprovalToken(executionId: string, stepId: string, attempt: number): Promise<string> {
  return sha256Hex(`${executionId}:${stepId}:${attempt}`).then((digest) => `wrf_rt_${digest.slice(0, 24)}`);
}

async function executeSteps(
  steps: NormalizedWorkflowStep[],
  ctx: ExecutionContext,
  sink: EventSink | undefined,
): Promise<ExecuteStepsResult> {
  for (const step of steps) {
    if (ctx.visitedSteps >= ctx.maxSteps) {
      return { failed: `max_steps_exceeded:${ctx.maxSteps}` };
    }

    ctx.visitedSteps += 1;
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
      const resumeToken = await createApprovalToken(ctx.executionId, step.id, ctx.attempt);
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

      if (branchRun.approval || branchRun.failed) return branchRun;
      continue;
    }

    if (step.type === 'parallel') {
      const branches = asStepArray(step.steps);
      const branchRun = await executeSteps(branches, ctx, sink);

      const completedAt = nowIso();
      result.status = 'completed';
      result.completedAt = completedAt;
      result.output = { branchCount: branches.length };

      emit(sink, { type: 'step.completed', executionId: ctx.executionId, stepId: step.id, attempt: ctx.attempt, ts: completedAt });

      if (branchRun.approval || branchRun.failed) return branchRun;
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

  const context: ExecutionContext = {
    executionId,
    attempt,
    variables: { ...(payload.variables || {}) },
    outputs: {},
    steps: [],
    maxSteps,
    visitedSteps: 0,
    hooks,
  };

  const run = await executeSteps(workflow.steps || [], context, sink);

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
    outputs: {},
    steps: [],
    maxSteps,
    visitedSteps: 0,
    hooks,
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
