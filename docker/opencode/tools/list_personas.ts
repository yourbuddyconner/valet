import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "List all available agent personas. " +
    "Personas are instruction sets that customize agent behavior for specific tasks or repos. " +
    "Use this to choose a persona when spawning child sessions.",
  args: {
    _placeholder: tool.schema.string().optional().describe("Unused"),
  },
  async execute() {
    try {
      const res = await fetch("http://localhost:9000/api/personas")

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list personas: ${errText}`
      }

      const data = (await res.json()) as { personas: unknown[] }

      if (!data.personas || data.personas.length === 0) {
        return "No personas configured."
      }

      return formatOutput(data.personas)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list personas: ${msg}`
    }
  },
})
