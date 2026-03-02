import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

function parseJsonObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "JSON must be an object." }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Invalid JSON: ${message}` }
  }
}

export default tool({
  description:
    "Run a trigger immediately by trigger ID. " +
    "For schedule target=orchestrator triggers, this dispatches the configured prompt to orchestrator.",
  args: {
    trigger_id: z.string().min(1).describe("Trigger ID"),
    variables_json: z.string().optional().describe("Optional JSON object for manual runtime variables"),
    repo_url: z.string().optional().describe("Optional git repository URL for the workflow session"),
    repo_branch: z.string().optional().describe("Optional branch to checkout"),
    repo_ref: z.string().optional().describe("Optional git ref to checkout"),
    source_repo_full_name: z.string().optional().describe("Optional owner/repo hint"),
  },
  async execute(args) {
    try {
      let variables: Record<string, unknown> | undefined
      if (args.variables_json && args.variables_json.trim().length > 0) {
        const parsed = parseJsonObject(args.variables_json)
        if (!parsed.ok) {
          return `Failed to run trigger: invalid variables_json. ${parsed.error}`
        }
        variables = parsed.value
      }

      const res = await fetch(`http://localhost:9000/api/triggers/${args.trigger_id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variables,
          repoUrl: args.repo_url,
          branch: args.repo_branch,
          ref: args.repo_ref,
          sourceRepoFullName: args.source_repo_full_name,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to run trigger: ${errText}`
      }

      const data = (await res.json()) as Record<string, unknown>
      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to run trigger: ${msg}`
    }
  },
})
