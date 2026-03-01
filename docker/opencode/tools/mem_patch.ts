import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Surgically edit a memory file without reading it first. " +
    "Supports append, prepend, find-and-replace, insert_after, and delete_section. " +
    "Ideal for journal entries (append), fact updates (replace), and section management. " +
    "If the file doesn't exist, append/prepend will create it; other ops are skipped.",
  args: {
    path: tool.schema
      .string()
      .min(1)
      .describe("File path to patch."),
    operations: tool.schema
      .array(
        tool.schema.object({
          op: tool.schema
            .enum(["append", "prepend", "replace", "replace_all", "insert_after", "delete_section"])
            .describe("Operation type."),
          content: tool.schema
            .string()
            .optional()
            .describe("Content for append/prepend/insert_after, or 'new' value for replace."),
          old: tool.schema
            .string()
            .optional()
            .describe("Text to find for replace/replace_all."),
          new: tool.schema
            .string()
            .optional()
            .describe("Replacement text for replace/replace_all."),
          anchor: tool.schema
            .string()
            .optional()
            .describe("Line to match for insert_after."),
          heading: tool.schema
            .string()
            .optional()
            .describe("Markdown heading for delete_section (e.g. '## Old Section')."),
        }),
      )
      .min(1)
      .describe("Operations to apply in order."),
  },
  async execute(args) {
    try {
      // Transform operations to the backend format
      const operations = args.operations.map((op) => {
        switch (op.op) {
          case "append":
          case "prepend":
            return { op: op.op, content: op.content || "" }
          case "replace":
          case "replace_all":
            return { op: op.op, old: op.old || "", new: op.new || "" }
          case "insert_after":
            return { op: op.op, anchor: op.anchor || "", content: op.content || "" }
          case "delete_section":
            return { op: op.op, heading: op.heading || "" }
          default:
            return op
        }
      })

      const res = await fetch("http://localhost:9000/api/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: args.path,
          operations,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to patch: ${errText}`
      }

      const data = (await res.json()) as {
        result: {
          version: number
          applied: number
          skipped: string[]
        }
      }

      const parts = [`Patched: ${args.path} (v${data.result.version}, ${data.result.applied} applied`]
      if (data.result.skipped.length > 0) {
        parts.push(`, ${data.result.skipped.length} skipped: ${data.result.skipped.join("; ")}`)
      }
      parts.push(")")
      return parts.join("")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to patch memory: ${msg}`
    }
  },
})
