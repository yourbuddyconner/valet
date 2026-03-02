import { tool } from "@opencode-ai/plugin"
import { formatOutput } from "./_format"

export default tool({
  description:
    "List available secrets from configured secret providers (e.g. 1Password). " +
    "Returns vault items with their reference URIs (e.g. op://vault/item/field). " +
    "No secret values are exposed — only names and references for use with secret_inject or secret_run.",
  args: {
    vault_id: tool.schema
      .string()
      .optional()
      .describe("Filter to a specific vault ID"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams()
      if (args.vault_id) params.set("vaultId", args.vault_id)

      const qs = params.toString()
      const res = await fetch(
        `http://localhost:9000/api/secrets/list${qs ? `?${qs}` : ""}`,
      )

      if (res.status === 501) {
        return "No secrets provider is configured for this sandbox."
      }

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list secrets: ${errText}`
      }

      const data = (await res.json()) as { secrets: unknown[] }

      if (!data.secrets || data.secrets.length === 0) {
        return "No secrets found."
      }

      return formatOutput(data.secrets)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list secrets: ${msg}`
    }
  },
})
