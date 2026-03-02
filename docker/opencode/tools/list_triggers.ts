import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

interface TriggerSummary {
  id: string
  workflowId: string | null
  workflowName: string | null
  name: string
  enabled: boolean
  type: "webhook" | "schedule" | "manual"
  config: Record<string, unknown>
  variableMapping: Record<string, string> | null
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export default tool({
  description:
    "List workflow triggers for the current user. " +
    "Use this before creating or updating triggers to avoid duplicates.",
  args: {
    workflow_id: tool.schema.string().optional().describe("Optional workflow ID/slug filter"),
    type: tool.schema.enum(["webhook", "schedule", "manual"]).optional().describe("Optional trigger type filter"),
    enabled: tool.schema.boolean().optional().describe("Optional enabled state filter"),
  },
  async execute(args) {
    try {
      const res = await fetch("http://localhost:9000/api/triggers")
      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list triggers: ${errText}`
      }

      const data = (await res.json()) as { triggers?: TriggerSummary[] }
      let triggers = data.triggers || []

      if (args.workflow_id) {
        const wanted = args.workflow_id
        triggers = triggers.filter((trigger) => trigger.workflowId === wanted || trigger.workflowName === wanted)
      }
      if (args.type) {
        triggers = triggers.filter((trigger) => trigger.type === args.type)
      }
      if (args.enabled !== undefined) {
        triggers = triggers.filter((trigger) => trigger.enabled === args.enabled)
      }

      if (triggers.length === 0) {
        return "No triggers found."
      }

      return formatOutput(triggers)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list triggers: ${msg}`
    }
  },
})
