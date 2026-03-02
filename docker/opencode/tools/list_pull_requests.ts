import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description:
    "List pull requests for a repository. Defaults to the current session repo when owner/repo are omitted. " +
    "Set owner and repo to inspect an arbitrary repository.",
  args: {
    owner: z.string().optional().describe("GitHub owner/org (optional)"),
    repo: z.string().optional().describe("GitHub repo name (optional)"),
    state: z.enum(["open", "closed", "all"]).optional().describe("PR state filter (default: open)"),
    limit: z.number().int().min(1).max(100).optional().describe("Max results to return (default: 30, max 100)"),
  },
  async execute(args) {
    try {
      if ((args.owner && !args.repo) || (!args.owner && args.repo)) {
        return "Both owner and repo are required when targeting a specific repository."
      }

      const params = new URLSearchParams()
      if (args.owner) params.set("owner", args.owner)
      if (args.repo) params.set("repo", args.repo)
      if (args.state) params.set("state", args.state)
      if (args.limit) params.set("limit", String(args.limit))

      const qs = params.toString()
      const res = await fetch(`http://localhost:9000/api/pull-requests${qs ? `?${qs}` : ""}`)

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list pull requests: ${errText}`
      }

      const data = (await res.json()) as { pulls: unknown[] }

      if (!data.pulls || data.pulls.length === 0) {
        return "No pull requests found."
      }

      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list pull requests: ${msg}`
    }
  },
})
