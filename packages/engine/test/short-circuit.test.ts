import { describe, it, expect } from "vitest";
import { shouldShortCircuit, deterministicGateId } from "../src/decision-gate.js";

const ctx = { sessionId: "s1", threadId: "t1", queueItemId: "q1", resumeKey: "do:x" };
const gateId = deterministicGateId(ctx);
const resolution = { actionId: "approve", resolvedBy: "u", resolvedAt: 1 };

describe("shouldShortCircuit", () => {
  it("returns no match when no suspendedDecision", () => {
    expect(shouldShortCircuit({ ctx, suspendedDecision: undefined }).match).toBe(false);
  });

  it("returns no match when gateId differs", () => {
    expect(
      shouldShortCircuit({
        ctx,
        suspendedDecision: { gateId: "gate:other", resolution },
      }).match,
    ).toBe(false);
  });

  it("returns no match when resolution is missing", () => {
    expect(shouldShortCircuit({ ctx, suspendedDecision: { gateId } }).match).toBe(false);
  });

  it("returns match + resolution when gateId and resolution are present", () => {
    const result = shouldShortCircuit({
      ctx,
      suspendedDecision: { gateId, resolution },
    });
    expect(result.match).toBe(true);
    if (result.match) expect(result.resolution).toEqual(resolution);
  });

  it("two ctx with same fields produce the same gateId", () => {
    const a = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k" });
    const b = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k" });
    expect(a).toBe(b);
  });

  it("differing resumeKey changes gateId", () => {
    const a = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k1" });
    const b = deterministicGateId({ sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k2" });
    expect(a).not.toBe(b);
  });
});
