import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "List tasks on the shared task board (orchestrator view). " +
    "Shows all tasks across the session hierarchy, with their status and dependencies. " +
    "Optionally filter by status.",
  args: {
    status: tool.schema
      .enum(["pending", "in_progress", "completed", "failed", "blocked"])
      .optional()
      .describe("Filter by task status"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum number of tasks to return (default: 100)"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams()
      if (args.status) params.set("status", args.status)
      if (args.limit) params.set("limit", String(args.limit))
      const qs = params.toString()

      const res = await fetch(`http://localhost:9000/api/tasks${qs ? `?${qs}` : ""}`)

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list tasks: ${errText}`
      }

      const data = (await res.json()) as { tasks: unknown[] }
      if (!data.tasks || data.tasks.length === 0) {
        return "No tasks found."
      }
      return formatOutput(data.tasks)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list tasks: ${msg}`
    }
  },
})
