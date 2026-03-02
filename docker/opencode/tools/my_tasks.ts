import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "List tasks assigned to this session. " +
    "This is the child session's view of the task board — only shows tasks where " +
    "session_id matches this session. Useful for checking what work has been delegated to you.",
  args: {
    status: tool.schema
      .enum(["pending", "in_progress", "completed", "failed", "blocked"])
      .optional()
      .describe("Filter by task status"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams()
      if (args.status) params.set("status", args.status)
      const qs = params.toString()

      const res = await fetch(`http://localhost:9000/api/my-tasks${qs ? `?${qs}` : ""}`)

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list my tasks: ${errText}`
      }

      const data = (await res.json()) as { tasks: unknown[] }
      if (!data.tasks || data.tasks.length === 0) {
        return "No tasks assigned to this session."
      }
      return formatOutput(data.tasks)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list my tasks: ${msg}`
    }
  },
})
