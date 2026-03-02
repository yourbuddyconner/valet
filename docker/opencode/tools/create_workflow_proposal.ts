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
    "Create a workflow mutation proposal for self-modifying workflows. " +
    "Requires the current base workflow hash and proposal JSON payload.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
    base_workflow_hash: z.string().min(1).describe("Current workflow hash"),
    proposal_json: z.string().describe("Proposal JSON object string"),
    execution_id: z.string().optional().describe("Optional source execution ID"),
    proposed_by_session_id: z.string().optional().describe("Optional source session ID"),
    diff_text: z.string().optional().describe("Optional human-readable diff text"),
    expires_at: z.string().optional().describe("Optional ISO-8601 expiry timestamp"),
  },
  async execute(args) {
    try {
      const parsedProposal = parseJsonObject(args.proposal_json)
      if (!parsedProposal.ok) {
        return `Failed to create workflow proposal: invalid proposal_json. ${parsedProposal.error}`
      }

      const res = await fetch(`http://localhost:9000/api/workflows/${encodeURIComponent(args.workflow_id)}/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionId: args.execution_id,
          proposedBySessionId: args.proposed_by_session_id,
          baseWorkflowHash: args.base_workflow_hash,
          proposal: parsedProposal.value,
          diffText: args.diff_text,
          expiresAt: args.expires_at,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to create workflow proposal: ${errText}`
      }

      const data = (await res.json()) as Record<string, unknown>
      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to create workflow proposal: ${msg}`
    }
  },
})
