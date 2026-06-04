import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Signal that your assigned task is fully complete and shut down this session. " +
    "Only call this after git status is clean, commits are pushed to a remote branch, and a PR has been created when the task changed code. " +
    "Calling this with uncommitted or unpushed work can destroy sandbox-only changes. " +
    "This will terminate your sandbox -- only call it when you are truly done.",
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
