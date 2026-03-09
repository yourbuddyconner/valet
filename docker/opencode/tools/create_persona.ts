import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Create a new agent persona. Personas are instruction sets that customize agent behavior " +
    "for specific tasks, repos, or workflows. Include a system prompt via the instructions field.",
  args: {
    name: tool.schema.string().describe("Human-readable persona name"),
    slug: tool.schema
      .string()
      .optional()
      .describe("URL-safe identifier (auto-generated from name if omitted)"),
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
      const slug =
        args.slug ||
        args.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")

      const body: Record<string, unknown> = {
        name: args.name,
        slug,
        visibility: args.visibility || "shared",
      }
      if (args.description) body.description = args.description
      if (args.icon) body.icon = args.icon
      if (args.instructions) {
        body.files = [
          { filename: "instructions.md", content: args.instructions, sortOrder: 0 },
        ]
      }

      const res = await fetch("http://localhost:9000/api/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to create persona: ${errText}`
      }

      const data = (await res.json()) as {
        persona: { id: string; name: string; slug: string }
      }
      return `Persona created: "${data.persona.name}" (id: ${data.persona.id}, slug: ${data.persona.slug})`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to create persona: ${msg}`
    }
  },
})
