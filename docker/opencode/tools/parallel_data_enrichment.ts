import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

const PARALLEL_API_BASE = "https://api.parallel.ai"
const POLL_INTERVAL_MS = 3000
const DEFAULT_TIMEOUT_MINUTES = 5
const MAX_TIMEOUT_MINUTES = 30

export default tool({
  description:
    "Enrich data using Parallel AI. This is an async operation that takes structured or " +
    "unstructured input, researches it on the web, and returns enriched data matching your " +
    "specified output schema. Use this for enriching company profiles, contact info, product " +
    "data, or any entity that benefits from web-sourced supplementary data.",
  args: {
    input: tool.schema
      .string()
      .describe("The data to enrich (entity name, URL, description, or structured JSON)"),
    output_schema: tool.schema
      .string()
      .describe(
        "JSON schema or natural language description of the desired output format. " +
        "Example: '{\"company_name\": \"string\", \"founded\": \"number\", \"description\": \"string\"}'"
      ),
    input_schema: tool.schema
      .string()
      .optional()
      .describe("Optional JSON schema describing the input format"),
    processor: tool.schema
      .enum(["base", "core"])
      .optional()
      .describe("Processing tier: 'base' for simple enrichment, 'core' for deeper research (default: base)"),
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
        task_type: "enrichment",
        input: args.input,
        output_schema: args.output_schema,
      }
      if (args.input_schema) createBody.input_schema = args.input_schema
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
        return `Failed to create enrichment task (${createRes.status}): ${errText}`
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
          return `Failed to check enrichment task status (${pollRes.status}): ${errText}`
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
            return `Enrichment completed but failed to fetch result (${resultRes.status}): ${errText}`
          }

          const resultData = await resultRes.json()
          return formatOutput(resultData)
        }

        if (pollData.status === "failed" || pollData.status === "cancelled") {
          return `Enrichment task ${pollData.status}. Run ID: ${runId}\n${formatOutput(pollData)}`
        }
      }

      return `Enrichment task timed out after ${timeoutMinutes} minutes. Run ID: ${runId} — you can check its status later.`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Parallel data enrichment failed: ${msg}`
    }
  },
})
