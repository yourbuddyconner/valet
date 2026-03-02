import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

interface ExecutionStepTrace {
  id: string
  stepId: string
  attempt: number
  status: string
  error: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

export default tool({
  description:
    "Fetch normalized per-step trace entries for a workflow execution. " +
    "Useful for debugging out-of-order display, approval gates, and step failures.",
  args: {
    execution_id: z.string().min(1).describe("Workflow execution ID"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Optional max number of steps to return (default 200)"),
  },
  async execute(args) {
    try {
      const res = await fetch(`http://localhost:9000/api/executions/${encodeURIComponent(args.execution_id)}/steps`)
      if (!res.ok) {
        const errText = await res.text()
        return `Failed to get execution steps: ${errText}`
      }

      const data = (await res.json()) as { steps?: ExecutionStepTrace[] }
      const steps = data.steps || []
      if (steps.length === 0) {
        return "No step traces found for this execution."
      }

      const limited = steps.slice(0, args.limit ?? 200)
      return formatOutput(limited)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to get execution steps: ${msg}`
    }
  },
})

