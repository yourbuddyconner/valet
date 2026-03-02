import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

const PARALLEL_API_BASE = "https://api.parallel.ai"
const POLL_INTERVAL_MS = 4000
const DEFAULT_TIMEOUT_MINUTES = 10
const MAX_TIMEOUT_MINUTES = 45

export default tool({
  description:
    "Run a deep research task using Parallel AI. This is an async operation that performs " +
    "multi-step web research, synthesizes findings, and returns a comprehensive report. " +
    "Use this for complex research questions that require analyzing multiple sources — " +
    "competitive analysis, technical deep dives, market research, etc. " +
    "This tool may take several minutes to complete.",
  args: {
    input: tool.schema
      .string()
      .describe("The research question or topic to investigate"),
    processor: tool.schema
      .enum(["pro", "ultra"])
      .optional()
      .describe("Research depth: 'pro' for standard research, 'ultra' for exhaustive analysis (default: pro)"),
    timeout_minutes: tool.schema
      .number()
      .optional()
      .describe(`Timeout in minutes (default: ${DEFAULT_TIMEOUT_MINUTES}, max: ${MAX_TIMEOUT_MINUTES})`),
  },
  async execute(args) {
    const apiKey = process.env.PARALLEL_API_KEY
    if (!apiKey) {
      return "Parallel API key is not configured. Ask an org admin to set the Parallel API key in Organization Settings."
    }

    const timeoutMinutes = Math.min(
      args.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES,
      MAX_TIMEOUT_MINUTES
    )
    const timeoutMs = timeoutMinutes * 60 * 1000

    try {
      // Create the task run
      const createBody: Record<string, unknown> = {
        task_type: "research",
        input: args.input,
      }
      if (args.processor) createBody.processor = args.processor

      const createRes = await fetch(`${PARALLEL_API_BASE}/v1/tasks/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(createBody),
      })

      if (!createRes.ok) {
        const errText = await createRes.text()
        return `Failed to create research task (${createRes.status}): ${errText}`
      }

      const createData = (await createRes.json()) as { run_id: string }
      const runId = createData.run_id

      // Poll until completion
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

        const pollRes = await fetch(
          `${PARALLEL_API_BASE}/v1/tasks/runs/${runId}`,
          {
            headers: { "x-api-key": apiKey },
          }
        )

        if (!pollRes.ok) {
          const errText = await pollRes.text()
          return `Failed to check research task status (${pollRes.status}): ${errText}`
        }

        const pollData = (await pollRes.json()) as { status: string }

        if (pollData.status === "completed") {
          // Fetch the result
          const resultRes = await fetch(
            `${PARALLEL_API_BASE}/v1/tasks/runs/${runId}/result`,
            {
              headers: { "x-api-key": apiKey },
            }
          )

          if (!resultRes.ok) {
            const errText = await resultRes.text()
            return `Research completed but failed to fetch result (${resultRes.status}): ${errText}`
          }

          const resultData = await resultRes.json()
          return formatOutput(resultData)
        }

        if (pollData.status === "failed" || pollData.status === "cancelled") {
          return `Research task ${pollData.status}. Run ID: ${runId}\n${formatOutput(pollData)}`
        }
      }

      return `Research task timed out after ${timeoutMinutes} minutes. Run ID: ${runId} — you can check its status later.`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Parallel deep research failed: ${msg}`
    }
  },
})
