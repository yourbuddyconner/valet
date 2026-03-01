import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Full-text search across all memory files. " +
    "Searches both file paths and content using keyword matching with stemming. " +
    "Optionally scope the search to a subtree (e.g. 'projects/').",
  args: {
    query: tool.schema
      .string()
      .min(1)
      .describe("Search query. Words are matched with OR. Example: 'deployment cloudflare'"),
    path: tool.schema
      .string()
      .optional()
      .describe("Optional path prefix to scope the search. Example: 'projects/'"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams({ query: args.query })
      if (args.path) params.set("path", args.path)

      const res = await fetch(
        `http://localhost:9000/api/memory/search?${params.toString()}`,
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Search failed: ${errText}`
      }

      const data = (await res.json()) as {
        results: { path: string; snippet: string; relevance: number }[]
      }

      if (!data.results || data.results.length === 0) {
        return `No matches for "${args.query}"`
      }

      const lines = [`Found ${data.results.length} match${data.results.length !== 1 ? "es" : ""} for "${args.query}":\n`]
      for (let i = 0; i < data.results.length; i++) {
        const r = data.results[i]
        const snippet = r.snippet.replace(/\n/g, " ").trim()
        lines.push(`${i + 1}. ${r.path} (relevance: ${r.relevance.toFixed(1)})`)
        lines.push(`   ${snippet}`)
        lines.push("")
      }

      return lines.join("\n")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Search failed: ${msg}`
    }
  },
})
