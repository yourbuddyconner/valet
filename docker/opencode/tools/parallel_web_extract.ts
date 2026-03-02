import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

const PARALLEL_API_BASE = "https://api.parallel.ai"

export default tool({
  description:
    "Extract content from web pages using Parallel AI. Fetches and parses one or more URLs, " +
    "returning clean text content. Use this when you have specific URLs and need their content — " +
    "articles, documentation pages, blog posts, etc.",
  args: {
    urls: tool.schema
      .array(tool.schema.string())
      .describe("URLs to extract content from"),
    objective: tool.schema
      .string()
      .optional()
      .describe("What specific information to focus on when extracting"),
    full_content: tool.schema
      .boolean()
      .optional()
      .describe("If true, return the full page content instead of a focused extraction"),
  },
  async execute(args) {
    const apiKey = process.env.PARALLEL_API_KEY
    if (!apiKey) {
      return "Parallel API key is not configured. Ask an org admin to set the Parallel API key in Organization Settings."
    }

    try {
      const body: Record<string, unknown> = {
        urls: args.urls,
      }
      if (args.objective) body.objective = args.objective
      if (args.full_content !== undefined) body.full_content = args.full_content

      const res = await fetch(`${PARALLEL_API_BASE}/v1beta/extract`, {
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
        return `Parallel extract failed (${res.status}): ${errText}`
      }

      const data = await res.json()
      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Parallel extract failed: ${msg}`
    }
  },
})
