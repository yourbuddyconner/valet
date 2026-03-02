import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

interface WorkflowSummary {
  id: string
  slug: string | null
  name: string
  description: string | null
  version: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export default tool({
  description:
    "List workflows available to the current user in Agent-Ops. " +
    "Use this before creating new workflows to avoid duplicates.",
  args: {
    _placeholder: tool.schema.string().optional().describe("Unused"),
  },
  async execute() {
    try {
      const res = await fetch("http://localhost:9000/api/workflows")
      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list workflows: ${errText}`
      }

      const data = (await res.json()) as { workflows?: WorkflowSummary[] }
      const workflows = data.workflows || []
      if (workflows.length === 0) {
        return "No workflows found."
      }

      return formatOutput(workflows)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list workflows: ${msg}`
    }
  },
})
