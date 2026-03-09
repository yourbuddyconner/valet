import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Create a new managed skill in the skill library. Skills are markdown documents that teach you " +
    "how to perform specific tasks. Created skills are private to your user by default. " +
    "Use YAML frontmatter for structured metadata (tags, version).",
  args: {
    name: tool.schema.string().describe("Human-readable skill name"),
    slug: tool.schema
      .string()
      .optional()
      .describe("URL-safe identifier (auto-generated from name if omitted)"),
    description: tool.schema
      .string()
      .optional()
      .describe("Brief description of what this skill teaches"),
    content: tool.schema
      .string()
      .describe(
        "Full markdown content of the skill. Can include YAML frontmatter with tags and version."
      ),
    visibility: tool.schema
      .enum(["private", "shared"])
      .optional()
      .describe("Visibility: 'private' (default, only you) or 'shared' (whole org)"),
  },
  async execute(args) {
    if (!args.name?.trim()) return "Error: name is required"
    if (!args.content?.trim()) return "Error: content is required"

    try {
      const res = await fetch("http://localhost:9000/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: args.name,
          slug: args.slug,
          description: args.description,
          content: args.content,
          visibility: args.visibility || "private",
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to create skill: ${errText}`
      }

      const data = (await res.json()) as { skill: { id: string; name: string; slug: string } }
      return `Skill created: "${data.skill.name}" (id: ${data.skill.id}, slug: ${data.skill.slug})`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to create skill: ${msg}`
    }
  },
})
