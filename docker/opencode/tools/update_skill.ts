import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Update an existing managed skill. Only skills you created (source: managed) can be edited. " +
    "You can update the name, description, content, or visibility.",
  args: {
    id: tool.schema.string().describe("Skill ID to update"),
    name: tool.schema.string().optional().describe("New skill name"),
    description: tool.schema.string().optional().describe("New description"),
    content: tool.schema.string().optional().describe("New markdown content"),
    visibility: tool.schema
      .enum(["private", "shared"])
      .optional()
      .describe("New visibility setting"),
  },
  async execute(args) {
    if (!args.id) return "Error: id is required"
    if (!args.name && !args.description && !args.content && !args.visibility) {
      return "Error: at least one field to update is required"
    }

    try {
      const body: Record<string, string> = {}
      if (args.name) body.name = args.name
      if (args.description) body.description = args.description
      if (args.content) body.content = args.content
      if (args.visibility) body.visibility = args.visibility

      const res = await fetch(`http://localhost:9000/api/skills/${args.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        if (res.status === 404) return "Skill not found or not editable."
        const errText = await res.text()
        return `Failed to update skill: ${errText}`
      }

      const data = (await res.json()) as { skill: { id: string; name: string } }
      return `Skill updated: "${data.skill.name}" (id: ${data.skill.id})`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to update skill: ${msg}`
    }
  },
})
