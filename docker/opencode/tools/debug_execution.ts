import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

type ExecutionStatus = "pending" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | string

interface Execution {
  id: string
  workflowId: string
  status: ExecutionStatus
  triggerType: string
  resumeToken?: string | null
  error?: string | null
  startedAt?: string
  completedAt?: string | null
}

interface StepTrace {
  id: string
  stepId: string
  attempt: number
  status: string
  error: string | null
  sequence?: number
  createdAt?: string
  startedAt?: string | null
  completedAt?: string | null
}

function statusCounts(steps: StepTrace[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const step of steps) {
    counts[step.status] = (counts[step.status] || 0) + 1
  }
  return counts
}

function extractMismatchStep(error: string | null | undefined): string | null {
  if (!error) return null
  const prefix = "resume_token_mismatch:"
  if (!error.startsWith(prefix)) return null
  const stepId = error.slice(prefix.length).trim()
  return stepId || null
}

export default tool({
  description:
    "Diagnose a workflow execution by combining execution metadata and normalized step traces. " +
    "Returns likely root cause plus concrete next actions.",
  args: {
    execution_id: z.string().min(1).describe("Workflow execution ID"),
    step_limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Optional maximum step rows to include in output (default 200)"),
  },
  async execute(args) {
    try {
      const execRes = await fetch(`http://localhost:9000/api/executions/${encodeURIComponent(args.execution_id)}`)
      if (!execRes.ok) {
        const errText = await execRes.text()
        return `Failed to debug execution: could not fetch execution. ${errText}`
      }

      const execData = (await execRes.json()) as { execution?: Execution }
      const execution = execData.execution
      if (!execution) {
        return `Failed to debug execution: execution ${args.execution_id} was not returned by API.`
      }

      const stepsRes = await fetch(`http://localhost:9000/api/executions/${encodeURIComponent(args.execution_id)}/steps`)
      if (!stepsRes.ok) {
        const errText = await stepsRes.text()
        return `Failed to debug execution: could not fetch step traces. ${errText}`
      }

      const stepsData = (await stepsRes.json()) as { steps?: StepTrace[] }
      const steps = (stepsData.steps || []).slice(0, args.step_limit ?? 200)

      const waitingSteps = steps.filter((step) => step.status === "waiting_approval")
      const failedSteps = steps.filter((step) => step.status === "failed")
      const runningSteps = steps.filter((step) => step.status === "running")
      const blockingStep = waitingSteps[0] || runningSteps[0] || failedSteps[0] || null
      const mismatchStepId = extractMismatchStep(execution.error || null)

      let diagnosis = "No obvious issue detected from execution metadata."
      const actions: string[] = []

      if (execution.status === "waiting_approval") {
        diagnosis = execution.resumeToken
          ? "Execution is blocked on approval and has an active resume token."
          : "Execution is waiting for approval but has no resume token persisted."
        if (execution.resumeToken) {
          actions.push(
            `Use approve_execution with execution_id=${execution.id}, approve=true, resume_token=<execution.resumeToken>.`,
          )
        }
      } else if (execution.status === "failed" && mismatchStepId) {
        const hasDifferentWaitingApproval = waitingSteps.some((step) => step.stepId !== mismatchStepId)
        diagnosis = hasDifferentWaitingApproval
          ? `Execution failed with ${execution.error}. This usually indicates a stale resume token was used for an earlier approval checkpoint.`
          : `Execution failed with ${execution.error}. Resume token likely did not match the currently paused checkpoint.`
        actions.push("Re-run get_execution and use the latest execution.resumeToken.")
        actions.push("If state is inconsistent, cancel_execution and start a fresh run.")
      } else if (execution.status === "running") {
        diagnosis = "Execution is currently running."
        actions.push("Use get_execution_steps again after a short delay to watch progress.")
      } else if (execution.status === "pending") {
        diagnosis = "Execution is queued/pending dispatch."
        actions.push("Wait briefly, then run get_execution again.")
      } else if (execution.status === "completed") {
        diagnosis = "Execution completed successfully."
      } else if (execution.status === "cancelled") {
        diagnosis = `Execution is cancelled${execution.error ? ` (${execution.error})` : ""}.`
      } else if (execution.status === "failed") {
        diagnosis = execution.error
          ? `Execution failed: ${execution.error}`
          : "Execution failed with no explicit error in execution metadata."
        if (failedSteps.length > 0) {
          actions.push("Inspect failed step errors in stepSummary.failedSteps.")
        }
        actions.push("If retrying, prefer starting a new run.")
      }

      const response = {
        executionSummary: {
          id: execution.id,
          workflowId: execution.workflowId,
          status: execution.status,
          triggerType: execution.triggerType,
          error: execution.error || null,
          hasResumeToken: !!execution.resumeToken,
          startedAt: execution.startedAt,
          completedAt: execution.completedAt || null,
        },
        stepSummary: {
          total: steps.length,
          statusCounts: statusCounts(steps),
          waitingApprovalSteps: waitingSteps.map((step) => step.stepId),
          failedSteps: failedSteps.map((step) => ({
            stepId: step.stepId,
            attempt: step.attempt,
            error: step.error,
          })),
          blockingStep: blockingStep
            ? {
                stepId: blockingStep.stepId,
                status: blockingStep.status,
                attempt: blockingStep.attempt,
                error: blockingStep.error,
                sequence: typeof blockingStep.sequence === "number" ? blockingStep.sequence : null,
              }
            : null,
        },
        diagnosis,
        recommendedActions: actions,
      }

      return formatOutput(response)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to debug execution: ${msg}`
    }
  },
})

