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
    "Run a workflow immediately by workflow ID or slug. " +
    "Returns execution details that can be checked in the Workflows UI.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
    variables_json: z
      .string()
      .optional()
      .describe("Optional JSON object string for runtime variables, e.g. {\"env\":\"prod\",\"dryRun\":true}"),
    repo_url: z
      .string()
      .optional()
      .describe("Optional git repository URL to clone into the workflow session"),
    repo_branch: z
      .string()
      .optional()
      .describe("Optional branch to checkout when repo_url is provided"),
    repo_ref: z
      .string()
      .optional()
      .describe("Optional git ref to checkout when repo_url is provided"),
    source_repo_full_name: z
      .string()
      .optional()
      .describe("Optional owner/repo hint (derived from repo_url when omitted)"),
  },
  async execute(args) {
    try {
      let variables: Record<string, unknown> | undefined
      if (args.variables_json && args.variables_json.trim().length > 0) {
        const parsed = parseJsonObject(args.variables_json)
        if (!parsed.ok) {
          return `Failed to run workflow: invalid variables_json. ${parsed.error}`
        }
        variables = parsed.value
      }

      const res = await fetch("http://localhost:9000/api/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: args.workflow_id,
          variables,
          repoUrl: args.repo_url,
          branch: args.repo_branch,
          ref: args.repo_ref,
          sourceRepoFullName: args.source_repo_full_name,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to run workflow: ${errText}`
      }

      const data = (await res.json()) as {
        execution?: {
          executionId?: string
          workflowName?: string
          status?: string
          dispatched?: boolean
        }
      } & Record<string, string | number | boolean | null | object>

      return formatOutput(data.execution || data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to run workflow: ${msg}`
    }
  },
})
