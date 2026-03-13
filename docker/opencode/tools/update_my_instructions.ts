import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Update your own custom instructions. These instructions shape your personality, " +
    "communication style, and behavior. Changes take effect on next session restart. " +
    "Pass the full instructions text — this replaces the current custom instructions entirely.",
  args: {
    instructions: tool.schema
      .string()
      .describe("The new custom instructions markdown content (replaces existing)"),
  },
  async execute(args) {
    if (!args.instructions?.trim()) {
      return "Error: instructions content is required"
    }

    try {
      const res = await fetch("http://localhost:9000/api/identity/instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: args.instructions }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to update instructions: ${errText}`
      }

      return "Custom instructions updated successfully. Changes will take effect on next session restart."
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to update instructions: ${msg}`
    }
  },
})
