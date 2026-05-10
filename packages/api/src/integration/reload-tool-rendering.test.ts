/**
 * Integration test: tool_call rendering survives a "reload".
 *
 * Boots a real `createApp(providers)` against an in-memory sqlite + virtual
 * sandbox, runs a real Anthropic-backed turn that calls a tool, then
 * REST-fetches messages (this is the path the client takes after a reload
 * now that WS init is metadata-only). Asserts the persisted state contains
 * a completed tool_call.
 *
 * Regression guard for two compounding bugs we shipped a fix for:
 *   1. The persisted entries' `parts` weren't surfacing in the rendered
 *      message list (originally because WS init stripped parts, now
 *      because GET /messages must include them).
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
import { driveTurn } from "./_test-utils.js";
import type {
  CreateSessionResponse,
  ListMessagesResponse,
} from "../wire/types.js";

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfKey("api integration: tool_call rendering survives reload", () => {
  it(
    "GET /messages after a turn returns persisted messages with completed tool_calls",
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

        // 3. "Reload" — fetch messages from REST, the same way the client
        //    does on initial mount + thread switch now that WS init is
        //    metadata-only.
        const msgRes = await fetch(
          `${api.baseUrl}/api/sessions/${sessionId}/messages`,
        );
        expect(msgRes.status).toBe(200);
        const { messages } = (await msgRes.json()) as ListMessagesResponse;

        // 4. Assert: persisted state includes at least one assistant message
        //    whose parts contain a completed tool_call. This fails if
        //    either bug regresses: GET /messages dropping parts, or the
        //    engine forgetting to re-persist tool completion.
        const assistantWithCompletedTool = messages.find(
          (m) =>
            m.role === "assistant" &&
            m.parts.some(
              (p) => p.kind === "tool_call" && p.status === "completed",
            ),
        );
        expect(
          assistantWithCompletedTool,
          `GET /messages returned ${messages.length} messages but none ` +
            `with a completed tool_call. Messages: ${JSON.stringify(
              messages.map((m) => ({
                role: m.role,
                partKinds: m.parts.map(
                  (p) => `${p.kind}${p.kind === "tool_call" ? `(${p.status})` : ""}`,
                ),
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
    60_000,
  );
});
