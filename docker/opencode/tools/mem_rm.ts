import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Delete a memory file or all files under a directory. " +
    "Use a path ending with '/' to delete all files under that prefix. " +
    "Use an exact file path to delete a single file.",
  args: {
    path: tool.schema
      .string()
      .min(1)
      .describe(
        "Path to delete. 'notes/outdated.md' deletes one file. " +
        "'journal/' deletes all journal files.",
      ),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams({ path: args.path })
      const res = await fetch(
        `http://localhost:9000/api/memory?${params.toString()}`,
        { method: "DELETE" },
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to delete: ${errText}`
      }

      const data = (await res.json()) as { deleted: number; success: boolean }
      if (!data.success) {
        return `Not found: ${args.path}`
      }

      const label = args.path.endsWith("/")
        ? `${data.deleted} file${data.deleted !== 1 ? "s" : ""} removed`
        : "deleted"
      return `Deleted: ${args.path} (${label})`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to delete memory: ${msg}`
    }
  },
})
