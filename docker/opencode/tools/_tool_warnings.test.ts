import { describe, expect, it } from "vitest"
import { formatNoToolsWithWarningsMessage, formatToolWarningLines } from "./_tool_warnings"

describe("tool warning formatting", () => {
  it("surfaces custom MCP request failures as discovery/configuration errors", () => {
    const lines = formatToolWarningLines([
      {
        service: "salesforce-read-only",
        displayName: "Salesforce (Read Only)",
        reason: "request_failed",
        message: "MCP salesforce-read-only initialize failed: HTTP 404 - Not Found",
      },
    ])

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("Salesforce (Read Only): Tool discovery failed")
    expect(lines[0]).toContain("HTTP 404")
    expect(lines[0]).toContain("check the connector configuration")
    expect(lines[0]).not.toContain("Authorization expired")
    expect(lines[0]).not.toContain("reauthorize")
    expect(formatNoToolsWithWarningsMessage()).toContain("tool discovery failures")
  })

  it("keeps auth failures actionable as reauthorization errors", () => {
    const lines = formatToolWarningLines([
      {
        service: "salesforce-read-only",
        displayName: "Salesforce (Read Only)",
        reason: "auth_failed",
        message: "HTTP 401 - JWT Token is required",
      },
    ])

    expect(lines[0]).toContain("Authorization expired or failed")
    expect(lines[0]).toContain("JWT Token is required")
    expect(lines[0]).toContain("reauthorize")
  })
})
