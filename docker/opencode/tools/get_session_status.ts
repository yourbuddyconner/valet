import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Get the current status of another agent session, including its recent messages. " +
    "Use this to check on child sessions' progress, see what they're working on, or determine if they're done. " +
    "Key statuses: running (active), idle (sandbox alive but agent idle), hibernated (sandbox stopped — not running, no processes alive), terminated (ended permanently). " +
    "If runnerConnected is false, the sandbox is not running. Only works with sessions belonging to the same user.",
  args: {
    session_id: tool.schema
      .string()
      .describe("The target session ID to get status for"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams({ sessionId: args.session_id })
      const res = await fetch(
        `http://localhost:9000/api/session-status?${params}`,
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to get session status: ${errText}`
      }

      const data = (await res.json()) as { sessionStatus: unknown }
      return formatOutput(data.sessionStatus)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to get session status: ${msg}`
    }
  },
})
