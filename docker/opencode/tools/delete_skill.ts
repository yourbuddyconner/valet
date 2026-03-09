import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Delete a managed skill from the skill library. Only skills you created (source: managed) can be deleted. " +
    "This also removes the skill from any persona attachments and org defaults.",
  args: {
    id: tool.schema.string().describe("Skill ID to delete"),
  },
  async execute(args) {
    if (!args.id) return "Error: id is required"

    try {
      const res = await fetch(`http://localhost:9000/api/skills/${args.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      })

      if (!res.ok) {
        if (res.status === 404) return "Skill not found or not deletable."
        const errText = await res.text()
        return `Failed to delete skill: ${errText}`
      }

      return "Skill deleted."
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to delete skill: ${msg}`
    }
  },
})
