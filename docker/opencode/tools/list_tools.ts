import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

interface ToolWarning {
  service: string
  displayName: string
  reason: string
  message: string
}

export default tool({
  description:
    "List available tools from connected integrations. Optionally filter by service name or search query. " +
    "Returns tool IDs, descriptions, risk levels, and parameter schemas. Use call_tool to invoke a tool by its ID.",
  args: {
    service: tool.schema
      .string()
      .optional()
      .describe("Filter by service name (e.g. 'gmail', 'github', 'google_calendar')"),
    query: tool.schema
      .string()
      .optional()
      .describe("Search tools by name or description"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams()
      if (args.service) params.set("service", args.service)
      if (args.query) params.set("query", args.query)
      const qs = params.toString()
      const url = `http://localhost:9000/api/tools${qs ? `?${qs}` : ""}`

      const res = await fetch(url)
      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list tools: ${errText}`
      }

      const data = (await res.json()) as { tools?: unknown[]; warnings?: ToolWarning[] }
      const tools = Array.isArray(data.tools) ? data.tools : []
      const warnings = Array.isArray(data.warnings) ? data.warnings : []

      // Build warning lines for integrations with auth failures
      const warningLines: string[] = []
      for (const w of warnings) {
        warningLines.push(`⚠ ${w.displayName}: Authorization expired or failed (${w.reason}) — the user should reauthorize in Settings > Integrations or via the banner in the session UI.`)
      }

      if (tools.length === 0 && warnings.length > 0) {
        return [
          ...warningLines,
          "",
          "No tools available because all integrations have auth failures. Ask the user to reauthorize their integrations.",
        ].join("\n")
      }

      if (tools.length === 0) {
        return args.service || args.query
          ? "No tools found matching the filter. Try listing all tools without filters."
          : "No tools available. The user may not have any active integrations configured."
      }

      const output = formatOutput(tools)
      if (warningLines.length > 0) {
        return warningLines.join("\n") + "\n\n" + output
      }

      return output
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list tools: ${msg}`
    }
  },
})
