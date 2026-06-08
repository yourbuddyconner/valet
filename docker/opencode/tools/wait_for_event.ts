import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Yield control and wait for the next incoming event. Call this when you have finished " +
    "your current work and are waiting for something external — a child session's notify_parent, " +
    "a user message, or any other prompt. Your turn ends immediately after this tool returns. " +
    "The next message you receive will be from whoever wakes you (child notification, user, etc.). " +
    "Prefer this over sleep loops when the wait time is unknown or when you expect a child " +
    "to notify you proactively. " +
    "IMPORTANT: To wait for a child session to finish its assigned task, use notify_on='status_change' " +
    "with statuses=['idle'] — NOT notify_on='terminal'. A child that completes work becomes 'idle' " +
    "(session still alive); 'terminal' only fires on 'terminated'/'error'/'hibernated'.",
  args: {
    reason: tool.schema
      .string()
      .optional()
      .describe(
        "Brief note about what you're waiting for (e.g. 'Waiting for child session to complete')",
      ),
    session_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "Optional list of child session IDs to monitor. If omitted, all child sessions are monitored.",
      ),
    notify_on: tool.schema
      .enum(["terminal", "status_change"])
      .optional()
      .describe(
        "Which events should wake you. 'terminal' (default) only fires when a child reaches a terminal status " +
        "(terminated, error, hibernated). NOTE: 'idle' is NOT a terminal status — a child that finishes its task " +
        "becomes idle (session still alive), not terminated. Use 'status_change' with statuses=['idle'] when " +
        "waiting for a child to complete its assigned task. 'status_change' fires on any child status transition.",
      ),
    statuses: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe(
        "Optional list of statuses to trigger on. Overrides notify_on. " +
        "To wait for a child to finish its task: statuses=['idle']. " +
        "To wait for a child session to be fully shut down: statuses=['terminated','error'].",
      ),
  },
  async execute(args) {
    // This tool is a pure yield — it returns immediately.
    // The Runner intercepts the completion, records the subscription args,
    // and ends the agent's turn. The DO will wake the agent later with a
    // structured system message when a matching event arrives.
    const parts: string[] = ["Yielding control."]
    if (args.reason) parts.push(`Reason: ${args.reason}`)
    if (args.session_ids?.length) parts.push(`Monitoring sessions: ${args.session_ids.join(", ")}`)
    if (args.notify_on) parts.push(`Notify on: ${args.notify_on}`)
    if (args.statuses?.length) parts.push(`Status filter: ${args.statuses.join(", ")}`)
    parts.push("Your turn is now over — do NOT call any more tools or generate further output.")
    return parts.join(" ")
  },
})
