/**
 * Integration test: tool_call rendering survives a WebSocket reload.
 *
 * Boots a real `createApp(providers)` against an in-memory sqlite + virtual
 * sandbox, runs a real Anthropic-backed turn that calls a tool, then opens a
 * FRESH WebSocket connection (simulating a page reload) and asserts the
 * init frame contains the completed tool_call.
 *
 * Regression guard for two compounding bugs we shipped a fix for:
 *   1. The init frame stripped `parts: []` from every persisted message.
 *   2. The engine persisted tool_call parts at message_end with
 *      `status: "running"` and never re-persisted on tool completion.
 *
 * Either bug alone produces the same symptom: tool cards appear during the
 * live turn, then vanish on reload.
 *
 * Skipped when `ANTHROPIC_API_KEY` is not set so CI without a key still
 * passes.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApi } from "./_setup.js";
import { captureInitFrame, driveTurn } from "./_test-utils.js";
import type { CreateSessionResponse } from "../wire/types.js";

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfKey("api integration: tool_call rendering survives WS reload", () => {
  it(
    "init frame after reconnect includes completed tool_call parts",
    async () => {
      const api = await bootTestApi();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "valet-reload-ws-"));
      try {
        // 1. Create a session.
        const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: workspaceRoot }),
        });
        expect(createRes.status).toBe(201);
        const { id: sessionId } = (await createRes.json()) as CreateSessionResponse;

        // 2. Drive a turn that should call the write tool.
        await driveTurn({
          baseUrl: api.baseUrl,
          wsUrl: api.wsUrl,
          sessionId,
          prompt:
            "Use the write tool to write the exact text 'hello world' to /workspace/note.txt. After the tool succeeds, just reply 'done'.",
        });

        // 3. Reload — open a fresh WS and capture the init frame.
        const initFrame = await captureInitFrame({ wsUrl: api.wsUrl, sessionId });

        // 4. Assert: the init frame's persisted messages include at least one
        //    assistant message whose parts have a completed tool_call. This
        //    fails if either bug regresses: init stripping parts (no parts
        //    visible) or engine forgetting to re-persist (tool_call stays
        //    status="running" with no result).
        expect(initFrame.type).toBe("init");
        if (initFrame.type !== "init") throw new Error("unreachable");
        const assistantWithCompletedTool = initFrame.messages.find(
          (m) =>
            m.role === "assistant" &&
            m.parts.some(
              (p) => p.kind === "tool_call" && p.status === "completed",
            ),
        );
        expect(
          assistantWithCompletedTool,
          `init frame had ${initFrame.messages.length} messages but none ` +
            `with a completed tool_call. Messages: ${JSON.stringify(
              initFrame.messages.map((m) => ({
                role: m.role,
                partKinds: m.parts.map((p) => `${p.kind}${p.kind === "tool_call" ? `(${p.status})` : ""}`),
              })),
              null,
              2,
            )}`,
        ).toBeDefined();

        const completedToolCall = assistantWithCompletedTool!.parts.find(
          (p) => p.kind === "tool_call" && p.status === "completed",
        );
        if (completedToolCall?.kind !== "tool_call") throw new Error("unreachable");
        expect(completedToolCall.result).toBeDefined();
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
        await api.cleanup();
      }
    },
    // Real Anthropic call needs more than the package's 10s default.
    60_000,
  );
});
