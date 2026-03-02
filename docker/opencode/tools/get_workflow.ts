import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description: "Get a workflow by ID or slug.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
  },
  async execute(args) {
    try {
      const res = await fetch(`http://localhost:9000/api/workflows/${encodeURIComponent(args.workflow_id)}`)
      if (!res.ok) {
        const errText = await res.text()
        return `Failed to get workflow: ${errText}`
      }

      const data = (await res.json()) as { workflow?: Record<string, unknown> }
      if (!data.workflow) {
        return `Failed to get workflow: workflow ${args.workflow_id} was not returned by API.`
      }

      return formatOutput(data.workflow)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to get workflow: ${msg}`
    }
  },
})
