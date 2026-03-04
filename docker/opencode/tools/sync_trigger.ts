import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

function parseJsonObject(raw: string): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "JSON must be an object." }
    }

    const value: Record<string, string> = {}
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof item !== "string") {
        return { ok: false, error: `Value for '${key}' must be a string.` }
      }
      value[key] = item
    }
    return { ok: true, value }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Invalid JSON: ${message}` }
  }
}

type TriggerConfig =
  | {
      type: "webhook"
      path: string
      method?: "GET" | "POST"
      secret?: string
    }
  | {
      type: "schedule"
      cron: string
      timezone?: string
      target?: "workflow" | "orchestrator"
      prompt?: string
    }
  | {
      type: "manual"
    }

interface TriggerResponse {
  id?: string
  workflowId?: string | null
  name?: string
  type?: string
  config?: TriggerConfig
  updatedAt?: string
}

export default tool({
  description:
    "Create or update a trigger in Valet. " +
    "Supports manual, webhook, and schedule triggers (including schedule target=orchestrator with prompt).",
  args: {
    trigger_id: z.string().optional().describe("If provided, update this trigger ID instead of creating a new one"),
    workflow_id: z.string().optional().describe("Workflow ID/slug. Required for webhook/manual and schedule target=workflow"),
    clear_workflow_link: z.boolean().optional().describe("For updates only, set workflowId to null"),
    name: z.string().min(1).describe("Trigger name"),
    enabled: z.boolean().optional().describe("Trigger enabled state"),
    type: z.enum(["webhook", "schedule", "manual"]).describe("Trigger type"),
    webhook_path: z.string().optional().describe("Webhook path (required for webhook type)"),
    webhook_method: z.enum(["GET", "POST"]).optional().describe("Webhook method (default POST)"),
    webhook_secret: z.string().optional().describe("Optional webhook secret"),
    schedule_cron: z.string().optional().describe("Cron expression (required for schedule type)"),
    schedule_timezone: z.string().optional().describe("IANA timezone for schedule triggers"),
    schedule_target: z.enum(["workflow", "orchestrator"]).optional().describe("Schedule target (default workflow)"),
    schedule_prompt: z.string().optional().describe("Prompt required when schedule_target=orchestrator"),
    variable_mapping_json: z
      .string()
      .optional()
      .describe("Optional JSON object mapping variable names to extraction paths"),
  },
  async execute(args) {
    try {
      const scheduleTarget = args.schedule_target || "workflow"

      let config: TriggerConfig
      if (args.type === "webhook") {
        if (!args.webhook_path || args.webhook_path.trim().length === 0) {
          return "Failed to sync trigger: webhook_path is required for webhook triggers."
        }
        config = {
          type: "webhook",
          path: args.webhook_path.trim(),
          method: args.webhook_method || "POST",
          secret: args.webhook_secret,
        }
      } else if (args.type === "schedule") {
        if (!args.schedule_cron || args.schedule_cron.trim().length === 0) {
          return "Failed to sync trigger: schedule_cron is required for schedule triggers."
        }
        if (scheduleTarget === "orchestrator" && (!args.schedule_prompt || args.schedule_prompt.trim().length === 0)) {
          return "Failed to sync trigger: schedule_prompt is required when schedule_target=orchestrator."
        }
        config = {
          type: "schedule",
          cron: args.schedule_cron.trim(),
          timezone: args.schedule_timezone,
          target: scheduleTarget,
          prompt: args.schedule_prompt,
        }
      } else {
        config = { type: "manual" }
      }

      let variableMapping: Record<string, string> | undefined
      if (args.variable_mapping_json && args.variable_mapping_json.trim().length > 0) {
        const parsed = parseJsonObject(args.variable_mapping_json)
        if (!parsed.ok) {
          return `Failed to sync trigger: invalid variable_mapping_json. ${parsed.error}`
        }
        variableMapping = parsed.value
      }

      const payload: {
        workflowId?: string | null
        name?: string
        enabled?: boolean
        config?: TriggerConfig
        variableMapping?: Record<string, string>
      } = {
        name: args.name,
        enabled: args.enabled,
        config,
      }

      const workflowRequired = args.type !== "schedule" || scheduleTarget === "workflow"
      if (workflowRequired && !args.workflow_id && !args.trigger_id) {
        return "Failed to sync trigger: workflow_id is required for this trigger type."
      }
      if (args.workflow_id) {
        payload.workflowId = args.workflow_id
      } else if (args.trigger_id && args.clear_workflow_link) {
        payload.workflowId = null
      }

      if (variableMapping) {
        payload.variableMapping = variableMapping
      }

      const isUpdate = !!args.trigger_id
      const endpoint = isUpdate ? `http://localhost:9000/api/triggers/${args.trigger_id}` : "http://localhost:9000/api/triggers"
      const method = isUpdate ? "PATCH" : "POST"

      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to sync trigger: ${errText}`
      }

      const data = (await res.json()) as { trigger?: TriggerResponse; success?: boolean }
      const trigger = data.trigger
      if (isUpdate) {
        return `Trigger updated: ${trigger?.id || args.trigger_id}`
      }
      return `Trigger created: ${trigger?.name || args.name} (${trigger?.id || "unknown-id"})`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to sync trigger: ${msg}`
    }
  },
})
