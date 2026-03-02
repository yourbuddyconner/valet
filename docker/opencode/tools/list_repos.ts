import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description:
    "List repositories. By default lists org-registered repos. " +
    'Set source to "github" to list the user\'s personal GitHub repos. ' +
    "Returns repo names, URLs, default branches, and any assigned personas (org) " +
    "or full_name, description, language, visibility (github).",
  args: {
    source: z
      .enum(["org", "github"])
      .default("org")
      .describe('Where to list repos from: "org" (default) or "github" (personal GitHub repos)'),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams()
      if (args.source) params.set("source", args.source)
      const qs = params.toString()
      const res = await fetch(`http://localhost:9000/api/org-repos${qs ? `?${qs}` : ""}`)

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list repos: ${errText}`
      }

      const data = (await res.json()) as { repos: unknown[] }

      if (!data.repos || data.repos.length === 0) {
        return args.source === "github"
          ? "No GitHub repositories found. The user may need to connect GitHub in settings."
          : "No repositories registered with the organization."
      }

      return formatOutput(data.repos)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list repos: ${msg}`
    }
  },
})
