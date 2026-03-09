import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Read the full content of a skill by ID or slug. Use search_skills first to find the skill you need, " +
    "then read_skill to load its full instructions into your context.",
  args: {
    id: tool.schema
      .string()
      .optional()
      .describe("Skill ID (from search_skills results)"),
    slug: tool.schema
      .string()
      .optional()
      .describe("Skill slug (URL-safe name)"),
  },
  async execute(args) {
    if (!args.id && !args.slug) {
      return "Error: must specify either id or slug"
    }

    try {
      const identifier = args.id || args.slug
      const res = await fetch(`http://localhost:9000/api/skills/${identifier}`, {
        headers: { "Content-Type": "application/json" },
      })

      if (!res.ok) {
        if (res.status === 404) return "Skill not found."
        const errText = await res.text()
        return `Failed to read skill: ${errText}`
      }

      const data = (await res.json()) as {
        skill: {
          id: string
          name: string
          slug: string
          source: string
          content: string
        }
      }

      return `# Skill: ${data.skill.name} (${data.skill.source})\n\n${data.skill.content}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to read skill: ${msg}`
    }
  },
})
