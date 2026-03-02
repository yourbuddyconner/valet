import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "List child sessions spawned by the current session. Returns each session's ID, title, status, workspace, and PR info. " +
    "Use this to see what sessions you've spawned, check their statuses, and find session IDs for further inspection with get_session_status or read_messages.",
  args: {},
  async execute() {
    try {
      const res = await fetch("http://localhost:9000/api/child-sessions")

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list sessions: ${errText}`
      }

      const data = (await res.json()) as { children: unknown[] }

      if (!data.children || data.children.length === 0) {
        return "No child sessions found."
      }

      return formatOutput(data.children)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list sessions: ${msg}`
    }
  },
})
