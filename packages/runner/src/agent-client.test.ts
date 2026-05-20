import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { APPROVAL_TIMEOUT_MS, SANDBOX_GATEWAY_IDLE_TIMEOUT_MS } from "./timeouts.js";

describe("AgentClient approval timeout contract", () => {
  it("keeps approval waits below the sandbox gateway idle timeout", () => {
    expect(APPROVAL_TIMEOUT_MS).toBeLessThan(SANDBOX_GATEWAY_IDLE_TIMEOUT_MS);
  });

  it("derives the Bun gateway idle timeout from the shared timeout constant", () => {
    const gatewaySource = readFileSync(new URL("./gateway.ts", import.meta.url), "utf8");
    expect(gatewaySource).toContain("SANDBOX_GATEWAY_IDLE_TIMEOUT_MS");
    expect(gatewaySource).toContain("idleTimeout: SANDBOX_GATEWAY_IDLE_TIMEOUT_MS / 1000");
    expect(gatewaySource).not.toContain("idleTimeout: 255");
  });
});
