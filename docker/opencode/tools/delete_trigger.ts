import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

export default tool({
  description: "Delete a trigger by ID or name.",
  args: {
    trigger_id: z.string().optional().describe("Trigger ID (UUID)"),
    name: z.string().optional().describe("Trigger name (alternative to trigger_id)"),
  },
  async execute(args) {
    let triggerId = args.trigger_id

    if (!triggerId && !args.name) {
      return "Failed to delete trigger: provide either trigger_id or name."
    }

    // Resolve name to ID if needed
    if (!triggerId && args.name) {
      try {
        const listRes = await fetch("http://localhost:9000/api/triggers")
        if (!listRes.ok) {
          return `Failed to delete trigger: could not list triggers to resolve name.`
        }
        const listData = (await listRes.json()) as { triggers?: { id: string; name: string }[] }
        const match = (listData.triggers || []).find(
          (t) => t.name.toLowerCase() === args.name!.toLowerCase()
        )
        if (!match) {
          return `Failed to delete trigger: no trigger found with name "${args.name}".`
        }
        triggerId = match.id
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return `Failed to delete trigger: ${msg}`
      }
    }

    const endpoint = `http://localhost:9000/api/triggers/${encodeURIComponent(triggerId!)}`

    // Use curl subprocess to avoid Bun fetch() connection reuse bugs
    // that cause "socket connection was closed unexpectedly" errors.
    const proc = Bun.spawn(["curl", "-sf", "-X", "DELETE", "-H", "Content-Type: application/json", endpoint], {
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `curl exit code ${exitCode}`
      return `Failed to delete trigger: ${detail}`
    }

    try {
      const data = JSON.parse(stdout)
      if (data.error) {
        return `Failed to delete trigger: ${data.error}`
      }
    } catch {
      // Non-JSON response is fine — success with no body
    }

    return `Trigger deleted: ${args.name || triggerId}`
  },
})
