import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Get your own orchestrator identity and persona. Returns your name, handle, " +
    "custom instructions, and linked persona ID. Use the persona ID with " +
    "list_persona_skills / attach_skill_to_persona / detach_skill_from_persona " +
    "to manage your own skills.",
  args: {
    _placeholder: tool.schema.string().optional().describe("Unused"),
  },
  async execute() {
    try {
      const res = await fetch("http://localhost:9000/api/identity")

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to get identity: ${errText}`
      }

      const data = await res.json()
      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to get identity: ${msg}`
    }
  },
})
