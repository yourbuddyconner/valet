import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Search the skill library for skills by keyword. Returns skill summaries (name, description, source, tags) " +
    "but not full content. Use read_skill to fetch the full content of a skill you want to use. " +
    "Skills teach you how to perform specific tasks, follow processes, or use tools effectively.",
  args: {
    query: tool.schema
      .string()
      .describe("Search query — matches against skill name, description, and content"),
    source: tool.schema
      .enum(["builtin", "plugin", "managed"])
      .optional()
      .describe("Filter by skill source type"),
  },
  async execute(args) {
    if (!args.query?.trim()) {
      return "Error: query is required"
    }

    try {
      const params = new URLSearchParams({ q: args.query })
      if (args.source) params.set("source", args.source)

      const res = await fetch(`http://localhost:9000/api/skills?${params}`, {
        headers: { "Content-Type": "application/json" },
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to search skills: ${errText}`
      }

      const data = (await res.json()) as {
        skills: Array<{
          id: string
          name: string
          slug: string
          description: string | null
          source: string
          visibility: string
          updatedAt: string
        }>
      }

      if (data.skills.length === 0) {
        return "No skills found matching your query."
      }

      const lines = data.skills.map(
        (s) =>
          `- **${s.name}** (${s.source}) [id: ${s.id}]\n  ${s.description || "No description"}`
      )
      return `Found ${data.skills.length} skill(s):\n\n${lines.join("\n\n")}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to search skills: ${msg}`
    }
  },
})
