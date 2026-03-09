import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Update an existing agent persona. You can update its name, description, icon, visibility, " +
    "or system prompt (instructions). Only personas you created can be edited (unless you are an admin).",
  args: {
    id: tool.schema.string().describe("Persona ID to update"),
    name: tool.schema.string().optional().describe("New persona name"),
    description: tool.schema.string().optional().describe("New description"),
    icon: tool.schema.string().optional().describe("New emoji icon"),
    instructions: tool.schema
      .string()
      .optional()
      .describe("New system prompt / instructions markdown content"),
    visibility: tool.schema
      .enum(["private", "shared"])
      .optional()
      .describe("New visibility setting"),
  },
  async execute(args) {
    if (!args.id) return "Error: id is required"
    if (
      !args.name &&
      !args.description &&
      !args.icon &&
      !args.instructions &&
      !args.visibility
    ) {
      return "Error: at least one field to update is required"
    }

    try {
      // Update persona metadata
      const meta: Record<string, string> = {}
      if (args.name) meta.name = args.name
      if (args.description) meta.description = args.description
      if (args.icon) meta.icon = args.icon
      if (args.visibility) meta.visibility = args.visibility

      if (Object.keys(meta).length > 0) {
        const res = await fetch(
          `http://localhost:9000/api/personas/${args.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(meta),
          }
        )

        if (!res.ok) {
          if (res.status === 404) return "Persona not found."
          const errText = await res.text()
          return `Failed to update persona: ${errText}`
        }
      }

      // Update instructions file if provided
      if (args.instructions) {
        const res = await fetch(
          `http://localhost:9000/api/personas/${args.id}/files`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: "instructions.md",
              content: args.instructions,
              sortOrder: 0,
            }),
          }
        )

        if (!res.ok) {
          const errText = await res.text()
          return `Persona metadata updated but failed to update instructions: ${errText}`
        }
      }

      return `Persona updated: ${args.id}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to update persona: ${msg}`
    }
  },
})
