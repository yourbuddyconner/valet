import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

interface ChannelBindingSummary {
  id: string
  sessionId: string
  channelType: string
  channelId: string
  scopeKey: string
  queueMode: string
  createdAt: string
}

export default tool({
  description:
    "List available channel destinations that this user/session can send replies to (Telegram, Slack, etc.). " +
    "Use this before channel_reply when you are not sure which channel_id to target.",
  args: {
    channel_type: tool.schema
      .enum(["telegram", "slack", "github", "api", "web"])
      .optional()
      .describe("Optional channel type filter"),
    include_web: tool.schema
      .boolean()
      .optional()
      .describe("Include web channels in results (default false)"),
  },
  async execute(args) {
    try {
      const res = await fetch("http://localhost:9000/api/channels")
      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list channels: ${errText}`
      }

      const data = (await res.json()) as { channels?: ChannelBindingSummary[] }
      let channels = Array.isArray(data.channels) ? data.channels : []

      if (!args.include_web) {
        channels = channels.filter((channel) => channel.channelType !== "web")
      }
      if (args.channel_type) {
        channels = channels.filter((channel) => channel.channelType === args.channel_type)
      }

      if (channels.length === 0) {
        return "No channels found."
      }

      return formatOutput(channels)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list channels: ${msg}`
    }
  },
})

