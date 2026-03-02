import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "List active tunnels registered in the sandbox gateway.",
  args: {
    _placeholder: tool.schema.string().optional().describe("Unused"),
  },
  async execute() {
    try {
      const res = await fetch("http://localhost:9000/api/tunnels")
      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list tunnels: ${errText}`
      }
      const data = await res.json() as { tunnels?: Array<{ name: string; path: string; port: number; protocol?: string }> }
      const tunnels = data.tunnels || []
      if (tunnels.length === 0) return "No tunnels registered"
      return tunnels
        .map((t) => `${t.name} -> ${t.path} (port ${t.port}${t.protocol ? `, ${t.protocol}` : ""})`)
        .join("\n")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list tunnels: ${msg}`
    }
  },
})
