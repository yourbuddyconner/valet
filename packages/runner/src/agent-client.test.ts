import { describe, expect, it } from "vitest";
import { APPROVAL_TIMEOUT_MS } from "./timeouts.js";

const BUN_GATEWAY_IDLE_TIMEOUT_MS = 255_000;

describe("AgentClient approval timeout contract", () => {
  it("keeps approval waits below the sandbox gateway idle timeout", () => {
    expect(APPROVAL_TIMEOUT_MS).toBeLessThan(BUN_GATEWAY_IDLE_TIMEOUT_MS);
  });
});
