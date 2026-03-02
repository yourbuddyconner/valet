import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

const PARALLEL_API_BASE = "https://api.parallel.ai"

export default tool({
  description:
    "Search the web using Parallel AI. Returns relevant search results with snippets and URLs. " +
    "Use this when you need current information from the internet — news, documentation, APIs, " +
    "product info, or any factual question that may benefit from live web data.",
  args: {
    objective: tool.schema
      .string()
      .describe("What you're trying to find or accomplish with this search"),
    queries: tool.schema
      .array(tool.schema.string())
      .describe("One or more search queries to execute"),
    max_results: tool.schema
      .number()
      .optional()
      .describe("Maximum number of results per query (default varies by mode)"),
    mode: tool.schema
      .enum(["fast", "one-shot", "agentic"])
      .optional()
      .describe(
        "Search mode: 'fast' for quick lookups, 'one-shot' for balanced results, " +
        "'agentic' for deep multi-step research (default: one-shot)"
      ),
  },
  async execute(args) {
    const apiKey = process.env.PARALLEL_API_KEY
    if (!apiKey) {
      return "Parallel API key is not configured. Ask an org admin to set the Parallel API key in Organization Settings."
    }

    try {
      const body: Record<string, unknown> = {
        objective: args.objective,
        queries: args.queries,
      }
      if (args.max_results !== undefined) body.max_results = args.max_results
      if (args.mode) body.mode = args.mode

      const res = await fetch(`${PARALLEL_API_BASE}/v1beta/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "parallel-beta": "search-extract-2025-10-10",
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Parallel search failed (${res.status}): ${errText}`
      }

      const data = await res.json()
      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Parallel search failed: ${msg}`
    }
  },
})
