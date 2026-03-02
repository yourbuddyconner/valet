import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Signal that your assigned task is fully complete and shut down this session. " +
    "Call this when you have finished all work, committed your changes, and have nothing left to do. " +
    "This will terminate your sandbox — only call it when you are truly done.",
  args: {
    _placeholder: tool.schema.string().optional().describe("Unused"),
  },
  async execute() {
    try {
      const res = await fetch("http://localhost:9000/api/complete-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to complete session: ${errText}`
      }

      return "Session marked as complete. Shutting down..."
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to complete session: ${msg}`
    }
  },
})
