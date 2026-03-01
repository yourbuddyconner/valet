import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Read a memory file or list a directory. " +
    "If the path ends with '/' or is empty, returns a directory listing. " +
    "If the path is a file (e.g. 'projects/agent-ops/repo.md'), returns its content. " +
    "Use this to recall user preferences, project context, and past decisions.",
  args: {
    path: tool.schema
      .string()
      .default("")
      .describe(
        "Path to read. Examples: '' (root listing), 'preferences/' (list preferences), " +
        "'projects/agent-ops/repo.md' (read file). Omit leading slash.",
      ),
  },
  async execute(args) {
    try {
      const path = args.path || ""
      const params = new URLSearchParams()
      if (path) params.set("path", path)

      const qs = params.toString()
      const res = await fetch(
        `http://localhost:9000/api/memory${qs ? `?${qs}` : ""}`,
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to read: ${errText}`
      }

      const data = (await res.json()) as {
        file?: { path: string; content: string; version: number; pinned: boolean; updatedAt: string }
        files?: { path: string; size: number; updatedAt: string; pinned: boolean }[]
      }

      // Directory listing
      if (data.files) {
        if (data.files.length === 0) {
          return path ? `No files under ${path}` : "Memory is empty. No files stored yet."
        }

        // Build a tree-like listing
        const lines = data.files.map((f) => {
          const sizeKb = (f.size / 1024).toFixed(1)
          const pin = f.pinned ? " [pinned]" : ""
          const ago = relativeTime(f.updatedAt)
          return `  ${f.path}  (${sizeKb} KB, ${ago})${pin}`
        })
        return lines.join("\n")
      }

      // File read
      if (data.file) {
        return data.file.content
      }

      return `File not found: ${path}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to read memory: ${msg}`
    }
  },
})

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
