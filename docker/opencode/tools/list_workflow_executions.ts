import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

interface WorkflowExecutionSummary {
  id: string
  workflowId: string
  workflowName: string | null
  sessionId: string | null
  triggerId: string | null
  status: string
  triggerType: string
  error: string | null
  startedAt: string
  completedAt: string | null
}

export default tool({
  description:
    "List recent workflow executions for the current user, optionally filtered by workflow.",
  args: {
    workflow_id: tool.schema.string().optional().describe("Optional workflow ID or slug filter"),
    limit: tool.schema.number().int().min(1).max(200).optional().describe("Max executions to return (default 20)"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams()
      if (args.workflow_id) params.set("workflowId", args.workflow_id)
      if (args.limit) params.set("limit", String(args.limit))

      const qs = params.toString()
      const res = await fetch(`http://localhost:9000/api/workflows/executions${qs ? `?${qs}` : ""}`)

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list workflow executions: ${errText}`
      }

      const data = (await res.json()) as { executions?: WorkflowExecutionSummary[] }
      const executions = data.executions || []
      if (executions.length === 0) {
        return "No workflow executions found."
      }

      return formatOutput(executions)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list workflow executions: ${msg}`
    }
  },
})
