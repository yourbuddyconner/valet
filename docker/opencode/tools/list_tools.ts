import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

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

      const data = (await res.json()) as { tools?: unknown[] }
      const tools = Array.isArray(data.tools) ? data.tools : []

      if (tools.length === 0) {
        return args.service || args.query
          ? "No tools found matching the filter. Try listing all tools without filters."
          : "No tools available. The user may not have any active integrations configured."
      }

      return formatOutput(tools)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list tools: ${msg}`
    }
  },
})
