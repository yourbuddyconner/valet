import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Register a tunnel for a local service running in the sandbox. " +
    "This creates a public URL (via Cloudflare Quick Tunnel) with its own unique hostname — " +
    "no base path or prefix needed. Apps served through the tunnel work as if hosted at /.",
  args: {
    name: tool.schema
      .string()
      .describe("Tunnel name (1-32 chars: a-z A-Z 0-9 _ -)"),
    port: tool.schema
      .number()
      .describe("Local port of the service inside the sandbox"),
    protocol: tool.schema
      .string()
      .optional()
      .describe("Protocol hint: http | ws | auto (default: http)"),
  },
  async execute(args) {
    try {
      const res = await fetch("http://localhost:9000/api/tunnels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: args.name,
          port: args.port,
          protocol: args.protocol,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to register tunnel: ${errText}`
      }

      const data = await res.json() as { tunnel?: { name: string; path: string; url?: string } }
      const url = data.tunnel?.url
      const path = data.tunnel?.path || `/t/${args.name}`

      if (url) {
        return `Tunnel registered: ${args.name}\nPublic URL: ${url}\nGateway path: ${path} (fallback)`
      }
      return `Tunnel registered: ${args.name} -> ${path} (cloudflared unavailable, using gateway path)`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to register tunnel: ${msg}`
    }
  },
})
