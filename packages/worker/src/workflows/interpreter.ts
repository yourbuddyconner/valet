/**
 * Cloudflare Workflow entrypoint for the DAG interpreter.
 *
 * The wrangler `[[workflows]]` binding instantiates this class. Each
 * execution gets one instance whose `run` method drives the wave loop
 * in runtime.ts.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { runWorkflowDag } from './runtime.js';
import { createD1TraceWriter } from './trace-writer.js';
import type { WorkflowRunParams, WorkflowRunResult } from './types.js';

export class ValetWorkflowInterpreter extends WorkflowEntrypoint<Env, WorkflowRunParams> {
  override async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ): Promise<WorkflowRunResult> {
    const traceWriter = createD1TraceWriter({
      env: this.env,
      mode: event.payload.mode ?? 'production',
    });
    return runWorkflowDag(this.env, event, step, { traceWriter });
  }
}
