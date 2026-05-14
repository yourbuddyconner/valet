import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Delete an agent persona by ID or name. Only personas you created can be deleted (unless you are an admin). " +
    "This also removes all associated files, skill attachments, and tool configurations.",
  args: {
    id: tool.schema.string().optional().describe("Persona ID to delete"),
    name: tool.schema.string().optional().describe("Persona name to delete (used if id not provided)"),
  },
  async execute(args) {
    if (!args.id && !args.name) return "Error: id or name is required"

    try {
      let personaId = args.id

      // Resolve name to ID if needed
      if (!personaId && args.name) {
        const listRes = await fetch("http://localhost:9000/api/personas")
        if (!listRes.ok) {
          return `Failed to list personas: ${await listRes.text()}`
        }
        const listData = (await listRes.json()) as {
          personas: Array<{ id: string; name: string }>
        }
        const match = listData.personas.find(
          (p) => p.name.toLowerCase() === args.name!.toLowerCase()
        )
        if (!match) {
          return `No persona found with name "${args.name}"`
        }
        personaId = match.id
      }

      const res = await fetch(
        `http://localhost:9000/api/personas/${personaId}`,
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
