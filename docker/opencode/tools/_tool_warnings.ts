export interface ToolWarning {
  service: string
  displayName: string
  reason: string
  message?: string
}

const AUTH_FAILURE_REASONS = new Set([
  "auth_failed",
  "decryption_failed",
  "expired",
  "not_found",
  "refresh_failed",
  "revoked",
])

export function formatToolWarningLines(warnings: ToolWarning[]): string[] {
  return warnings.map((warning) => {
    const detail = warning.message ? `: ${warning.message}` : ""
    if (AUTH_FAILURE_REASONS.has(warning.reason)) {
      return `⚠ ${warning.displayName}: Authorization expired or failed (${warning.reason})${detail} — the user should reauthorize in Settings > Integrations or via the banner in the session UI.`
    }
    return `⚠ ${warning.displayName}: Tool discovery failed (${warning.reason})${detail} — check the connector configuration in Settings.`
  })
}

export function formatNoToolsWithWarningsMessage(): string {
  return "No tools available because integrations have tool discovery failures. Review the warning details above."
}
