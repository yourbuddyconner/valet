import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Create or overwrite a memory file. " +
    "Memories persist across conversations and sandbox restarts. " +
    "Use paths to organize: preferences/, projects/<name>/, workflows/, journal/, notes/. " +
    "Files under preferences/ are auto-pinned (never pruned). " +
    "Writing to an existing path replaces the content and bumps the version.",
  args: {
    path: tool.schema
      .string()
      .min(1)
      .describe(
        "File path (no leading slash). Examples: 'preferences/coding-style.md', " +
        "'projects/agent-ops/repo.md', 'notes/team.md'",
      ),
    content: tool.schema
      .string()
      .min(1)
      .describe("The file content (markdown recommended)."),
  },
  async execute(args) {
    try {
      const res = await fetch("http://localhost:9000/api/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: args.path,
          content: args.content,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to write: ${errText}`
      }

      const data = (await res.json()) as {
        file: { path: string; version: number; pinned: boolean }
      }
      const sizeKb = (args.content.length / 1024).toFixed(1)
      const pin = data.file.pinned ? " [pinned]" : ""
      return `Written: ${data.file.path} (v${data.file.version}, ${sizeKb} KB)${pin}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to write memory: ${msg}`
    }
  },
})
