import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Check unread notifications sent to this session. " +
    "Returns persistent cross-session queue items (distinct from session chat history). " +
    "Items are automatically marked as read after retrieval. " +
    "Use this to check for async updates from other agents, the orchestrator, or users.",
  args: {
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum number of messages to return (default: 50)"),
    after: tool.schema
      .string()
      .optional()
      .describe("Only return messages created after this ISO timestamp"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams()
      if (args.limit) params.set("limit", String(args.limit))
      if (args.after) params.set("after", args.after)
      const qs = params.toString()

      const res = await fetch(`http://localhost:9000/api/notifications${qs ? `?${qs}` : ""}`)

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to check notifications: ${errText}`
      }

      const data = (await res.json()) as { notifications: unknown[] }
      if (!data.notifications || data.notifications.length === 0) {
        return "No unread notifications."
      }
      return formatOutput(data.notifications)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to check notifications: ${msg}`
    }
  },
})
