import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { denyInWorkflowSession } from "./_workflow_session_guard"

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

function hasValidSteps(payload: Record<string, unknown>): boolean {
  const steps = payload.steps
  return Array.isArray(steps) && steps.length > 0
}

// NOTE: the authoritative step-type taxonomy lives in the worker
// (packages/worker/src/lib/workflow-definition.ts) and the runner
// (packages/runner/src/workflow-compiler.ts). This tool intentionally does
// NOT re-enumerate valid step types — doing so previously let the list drift
// out of sync and rejected valid `agent_prompt`/`notify` steps. We keep only
// stable structural checks here and let the worker reject unknown types.
function validateStep(step: unknown, path: string): string | null {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return `${path} must be an object`
  }

  const stepRecord = step as Record<string, unknown>
  const stepType = stepRecord.type
  if (typeof stepType !== "string" || !stepType.trim()) {
    return `${path}.type is required (e.g. agent_prompt, notify, bash, tool, conditional, loop, parallel, approval).`
  }

  const normalizedType = stepType.trim()

  // Type-specific structural hints (stable; not a type allowlist).
  if (normalizedType === "bash") {
    if (typeof stepRecord.command !== "string" || !stepRecord.command.trim()) {
      return `${path}: bash step requires a "command" field (string). Example: { "type": "bash", "command": "npm test" }`
    }
  }

  if (normalizedType === "tool") {
    if (typeof stepRecord.tool !== "string" || !stepRecord.tool.trim()) {
      return `${path}: tool step requires a "tool" field (string). For shell commands, prefer type: "bash" with a "command" field instead.`
    }
    // Suggest bash type if they're using tool+bash
    if (stepRecord.tool === "bash") {
      return `${path}: instead of type: "tool" with tool: "bash", use type: "bash" with a "command" field. Example: { "type": "bash", "command": "npm test" }`
    }
  }

  for (const nestedKey of ["then", "else", "steps"] as const) {
    if (!(nestedKey in stepRecord) || stepRecord[nestedKey] == null) continue
    const nested = stepRecord[nestedKey]
    if (!Array.isArray(nested)) {
      return `${path}.${nestedKey} must be an array`
    }
    for (let i = 0; i < nested.length; i += 1) {
      const nestedError = validateStep(nested[i], `${path}.${nestedKey}[${i}]`)
      if (nestedError) return nestedError
    }
  }

  return null
}

function validateWorkflowPayload(payload: Record<string, unknown>): string | null {
  if (!hasValidSteps(payload)) {
    return "workflow.steps must be a non-empty array"
  }

  const steps = payload.steps as unknown[]
  for (let i = 0; i < steps.length; i += 1) {
    const error = validateStep(steps[i], `workflow.steps[${i}]`)
    if (error) return error
  }

  return null
}

export default tool({
  description:
    "Create or update a workflow in Valet. " +
    "This immediately syncs the workflow to the backend so it appears on the Workflows page. " +
    "Step types: agent_prompt (calls the agent, captures its reply), notify, bash (requires command field), tool, conditional, loop, parallel, approval. " +
    "For shell commands use type: \"bash\" with a \"command\" field — NOT type: \"tool\" with tool: \"bash\".",
  args: {
    id: z.string().optional().describe("Optional stable workflow ID"),
    slug: z.string().optional().describe("Optional workflow slug"),
    name: z.string().min(1).describe("Workflow name"),
    description: z.string().optional().describe("Workflow description"),
    version: z.string().optional().describe("Workflow version (default 1.0.0)"),
    data_json: z
      .string()
      .optional()
      .describe(
        'Workflow definition JSON string with a non-empty "steps" array. ' +
        'Each step needs id, name, type. Bash steps: {"id":"1","name":"Run tests","type":"bash","command":"npm test"}. ' +
        'Do NOT use type:"tool" with tool:"bash" — use type:"bash" with command field instead.'
      ),
    workflow_json: z
      .string()
      .optional()
      .describe("Alias for data_json"),
  },
  async execute(args) {
    const denied = denyInWorkflowSession("sync_workflow")
    if (denied) return denied

    try {
      const rawPayload = args.data_json ?? args.workflow_json
      if (!rawPayload) {
        return "Invalid workflow definition: provide data_json/workflow_json with a non-empty steps array."
      }
      const parsed = parseJsonObject(rawPayload)
      if (!parsed.ok) {
        return `Failed to sync workflow: invalid workflow JSON. ${parsed.error}`
      }
      const validationError = validateWorkflowPayload(parsed.value)
      if (validationError) {
        return `Invalid workflow definition: ${validationError}`
      }

      const res = await fetch("http://localhost:9000/api/workflows/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: args.id,
          slug: args.slug,
          name: args.name,
          description: args.description,
          version: args.version,
          data: parsed.value,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to sync workflow: ${errText}`
      }

      const data = (await res.json()) as { success?: boolean; id?: string; error?: string; workflow?: { id?: string; name?: string } }
      if (data.success === false) {
        return `Failed to sync workflow: ${data.error || "sync failed"}`
      }
      const wf = data.workflow
      const wfId = wf?.id || data.id || args.id || "(generated)"
      const wfName = wf?.name || args.name
      return `Workflow synced: ${wfName} (${wfId})`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to sync workflow: ${msg}`
    }
  },
})
