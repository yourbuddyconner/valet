import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Fetch a single workflow execution by ID. " +
    "Use this to inspect status, error, resume token, trigger metadata, and outputs.",
  args: {
    execution_id: z.string().min(1).describe("Workflow execution ID"),
  },
  async execute(args) {
    try {
      const res = await fetch(`http://localhost:9000/api/executions/${encodeURIComponent(args.execution_id)}`)
      if (!res.ok) {
        const errText = await res.text()
        return `Failed to get execution: ${errText}`
      }

      const data = (await res.json()) as { execution?: Record<string, unknown> }
      if (!data.execution) {
        return `Failed to get execution: execution ${args.execution_id} was not returned by API.`
      }

      return formatOutput(data.execution)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to get execution: ${msg}`
    }
  },
})

