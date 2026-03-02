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

function parseStringArray(raw: string): { ok: true; value: string[] } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "JSON must be an array." }
    }
    for (const item of parsed) {
      if (typeof item !== "string") {
        return { ok: false, error: "All array items must be strings." }
      }
    }
    return { ok: true, value: parsed as string[] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Invalid JSON: ${message}` }
  }
}

export default tool({
  description:
    "Update workflow metadata or definition by ID/slug. " +
    "Supports name, description, slug, version, enabled, tags, and full data.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
    name: z.string().optional().describe("Updated workflow name"),
    description: z.string().optional().describe("Updated workflow description"),
    clear_description: z.boolean().optional().describe("Set description to null"),
    slug: z.string().optional().describe("Updated slug"),
    clear_slug: z.boolean().optional().describe("Set slug to null"),
    version: z.string().optional().describe("Updated version"),
    enabled: z.boolean().optional().describe("Enabled state"),
    tags_json: z.string().optional().describe("JSON array of string tags"),
    data_json: z.string().optional().describe("Full workflow data JSON object"),
  },
  async execute(args) {
    try {
      const payload: {
        name?: string
        description?: string | null
        slug?: string | null
        version?: string
        enabled?: boolean
        tags?: string[]
        data?: Record<string, unknown>
      } = {}

      if (args.name !== undefined) payload.name = args.name

      if (args.clear_description === true) {
        payload.description = null
      } else if (args.description !== undefined) {
        payload.description = args.description
      }

      if (args.clear_slug === true) {
        payload.slug = null
      } else if (args.slug !== undefined) {
        payload.slug = args.slug
      }

      if (args.version !== undefined) payload.version = args.version
      if (args.enabled !== undefined) payload.enabled = args.enabled

      if (args.tags_json && args.tags_json.trim().length > 0) {
        const parsedTags = parseStringArray(args.tags_json)
        if (!parsedTags.ok) {
          return `Failed to update workflow: invalid tags_json. ${parsedTags.error}`
        }
        payload.tags = parsedTags.value
      }

      if (args.data_json && args.data_json.trim().length > 0) {
        const parsedData = parseJsonObject(args.data_json)
        if (!parsedData.ok) {
          return `Failed to update workflow: invalid data_json. ${parsedData.error}`
        }
        payload.data = parsedData.value
      }

      if (Object.keys(payload).length === 0) {
        return "Failed to update workflow: provide at least one field to update."
      }

      const res = await fetch(`http://localhost:9000/api/workflows/${encodeURIComponent(args.workflow_id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to update workflow: ${errText}`
      }

      const data = (await res.json()) as { workflow?: Record<string, unknown> }
      return formatOutput(data.workflow || data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to update workflow: ${msg}`
    }
  },
})
