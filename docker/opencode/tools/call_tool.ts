import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Call a tool by its ID with the given parameters. Use list_tools first to discover available tools and their required parameters.",
  args: {
    tool_id: tool.schema
      .string()
      .describe("The fully-qualified tool ID (e.g. 'gmail:send_email', 'github:create_issue')"),
    params: tool.schema
      .string()
      .optional()
      .describe("JSON object of parameters for the tool. Must match the schema from list_tools."),
    summary: tool.schema
      .string()
      .describe("A brief, human-readable summary of what this tool call will do and why. This is shown to the user for approval. Example: 'Send a Slack message to #engineering with the deployment status update'"),
  },
  async execute(args) {
    try {
      if (!args.tool_id) {
        return "Error: tool_id is required. Use list_tools to discover available tools."
      }
      if (!args.summary) {
        return "Error: summary is required. Provide a brief human-readable description of what this tool call does."
      }

      let params: Record<string, unknown> = {}
      if (args.params) {
        try {
          params = JSON.parse(args.params)
        } catch {
          return "Error: params must be a valid JSON object."
        }
      }

      const res = await fetch("http://localhost:9000/api/tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId: args.tool_id, params, summary: args.summary }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Tool call failed: ${errText}`
      }

      const data = (await res.json()) as { result?: unknown; error?: string }
      if (data.error) {
        return `Tool error: ${data.error}`
      }

      if (data.result === undefined || data.result === null) {
        return "Tool executed successfully (no data returned)."
      }

      return formatOutput(data.result)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to call tool: ${msg}`
    }
  },
})
