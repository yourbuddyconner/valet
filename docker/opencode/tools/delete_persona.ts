import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Delete an agent persona. Only personas you created can be deleted (unless you are an admin). " +
    "This also removes all associated files, skill attachments, and tool configurations.",
  args: {
    id: tool.schema.string().describe("Persona ID to delete"),
  },
  async execute(args) {
    if (!args.id) return "Error: id is required"

    try {
      const res = await fetch(
        `http://localhost:9000/api/personas/${args.id}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        }
      )

      if (!res.ok) {
        if (res.status === 404) return "Persona not found or not deletable."
        const errText = await res.text()
        return `Failed to delete persona: ${errText}`
      }

      return "Persona deleted."
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to delete persona: ${msg}`
    }
  },
})
