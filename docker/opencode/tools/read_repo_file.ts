import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Read a file directly from a GitHub repository you have access to. " +
    "Use this when you need to inspect repo files without spawning a child session. " +
    "Provide either owner+repo, repo (owner/repo), or repo_url. Optionally specify ref (branch/sha).",
  args: {
    path: tool.schema
      .string()
      .describe("File path in the repository (e.g. 'scripts/seed-database.ts')"),
    repo: tool.schema
      .string()
      .optional()
      .describe("Repository in owner/repo format (e.g. 'yourbuddyconner/hellacamping-3')"),
    owner: tool.schema
      .string()
      .optional()
      .describe("Repository owner (use with repo)"),
    repo_name: tool.schema
      .string()
      .optional()
      .describe("Repository name (use with owner)"),
    repo_url: tool.schema
      .string()
      .optional()
      .describe("Repository URL (https or git@)"),
    ref: tool.schema
      .string()
      .optional()
      .describe("Git ref (branch, tag, or commit SHA)"),
  },
  async execute(args) {
    try {
      const body = {
        path: args.path,
        owner: args.owner,
        repo: args.repo_name || args.repo,
        repoUrl: args.repo_url,
        ref: args.ref,
      }

      const res = await fetch("http://localhost:9000/api/read-repo-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to read repo file: ${errText}`
      }

      const data = (await res.json()) as {
        content: string
        encoding?: string
        truncated?: boolean
        path?: string
        repo?: string
        ref?: string
      }

      const meta = {
        repo: data.repo,
        path: data.path,
        ref: data.ref,
        truncated: data.truncated || false,
      }

      return formatOutput({ meta, content: data.content })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to read repo file: ${msg}`
    }
  },
})
