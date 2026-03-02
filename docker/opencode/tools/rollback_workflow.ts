import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Roll back a workflow definition to a historical hash from list_workflow_history. " +
    "Optionally override version and add notes.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
    target_workflow_hash: z.string().min(1).describe("Target workflow hash to restore"),
    version: z.string().optional().describe("Optional version override after rollback"),
    notes: z.string().optional().describe("Optional rollback note"),
  },
  async execute(args) {
    try {
      const res = await fetch(`http://localhost:9000/api/workflows/${encodeURIComponent(args.workflow_id)}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetWorkflowHash: args.target_workflow_hash,
          version: args.version,
          notes: args.notes,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to rollback workflow: ${errText}`
      }

      const data = (await res.json()) as Record<string, unknown>
      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to rollback workflow: ${msg}`
    }
  },
})
