import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Inspect a pull request with files/line counts, review comments (non-dismissed), checks, and status. " +
    "Defaults to the current session repo when owner/repo are omitted.",
  args: {
    prNumber: z.number().int().min(1).describe("Pull request number"),
    owner: z.string().optional().describe("GitHub owner/org (optional)"),
    repo: z.string().optional().describe("GitHub repo name (optional)"),
    filesLimit: z.number().int().min(1).max(300).optional().describe("Max files to return (default: 200, max 300)"),
    commentsLimit: z.number().int().min(1).max(300).optional().describe("Max review comments to return (default: 100, max 300)"),
  },
  async execute(args) {
    try {
      if ((args.owner && !args.repo) || (!args.owner && args.repo)) {
        return "Both owner and repo are required when targeting a specific repository."
      }

      const params = new URLSearchParams()
      params.set("pr_number", String(args.prNumber))
      if (args.owner) params.set("owner", args.owner)
      if (args.repo) params.set("repo", args.repo)
      if (args.filesLimit) params.set("files_limit", String(args.filesLimit))
      if (args.commentsLimit) params.set("comments_limit", String(args.commentsLimit))

      const res = await fetch(`http://localhost:9000/api/pull-request?${params.toString()}`)

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to inspect pull request: ${errText}`
      }

      const data = await res.json()
      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to inspect pull request: ${msg}`
    }
  },
})
