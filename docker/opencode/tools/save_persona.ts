import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Create or update an agent persona by name. Idempotent — calling with the same name " +
    "updates the existing persona rather than creating a duplicate. Personas are instruction " +
    "sets that customize agent behavior for specific tasks, repos, or workflows.",
  args: {
    name: tool.schema.string().describe("Persona name (used as the unique identifier)"),
    description: tool.schema
      .string()
      .optional()
      .describe("Brief description of what this persona does"),
    icon: tool.schema
      .string()
      .optional()
      .describe("Emoji icon for the persona"),
    instructions: tool.schema
      .string()
      .optional()
      .describe("System prompt / instructions markdown content (saved as instructions.md)"),
    visibility: tool.schema
      .enum(["private", "shared"])
      .optional()
      .describe("Visibility: 'private' (only you) or 'shared' (default, whole org)"),
  },
  async execute(args) {
    if (!args.name?.trim()) return "Error: name is required"

    try {
      // Check if a persona with this name already exists
      const listRes = await fetch("http://localhost:9000/api/personas")
      if (!listRes.ok) {
        return `Failed to list personas: ${await listRes.text()}`
      }
      const listData = (await listRes.json()) as {
        personas: Array<{ id: string; name: string }>
      }
      const existing = listData.personas.find(
        (p) => p.name.toLowerCase() === args.name.trim().toLowerCase()
      )

      if (existing) {
        // Update existing persona metadata
        const meta: Record<string, string> = { name: args.name.trim() }
        if (args.description) meta.description = args.description
        if (args.icon) meta.icon = args.icon
        if (args.visibility) meta.visibility = args.visibility

        const updateRes = await fetch(
          `http://localhost:9000/api/personas/${existing.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(meta),
          }
        )
        if (!updateRes.ok) {
          return `Failed to update persona: ${await updateRes.text()}`
        }

        // Upsert instructions file if provided
        if (args.instructions) {
          const fileRes = await fetch(
            `http://localhost:9000/api/personas/${existing.id}/files`,
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
          if (!fileRes.ok) {
            return `Persona metadata updated but failed to update instructions: ${await fileRes.text()}`
          }
        }

        return `Persona updated: "${existing.name}" (id: ${existing.id})`
      }

      // Create new persona
      const body: Record<string, unknown> = {
        name: args.name.trim(),
        visibility: args.visibility || "shared",
      }
      if (args.description) body.description = args.description
      if (args.icon) body.icon = args.icon
      if (args.instructions) {
        body.files = [
          { filename: "instructions.md", content: args.instructions, sortOrder: 0 },
        ]
      }

      const createRes = await fetch("http://localhost:9000/api/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!createRes.ok) {
        return `Failed to create persona: ${await createRes.text()}`
      }

      const data = (await createRes.json()) as {
        persona: { id: string; name: string }
      }
      return `Persona created: "${data.persona.name}" (id: ${data.persona.id})`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to save persona: ${msg}`
    }
  },
})
