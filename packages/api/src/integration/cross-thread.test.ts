/**
 * Integration test: cross-thread reads via the engine's `thread_read` tool.
 *
 * Drives two real Anthropic-backed turns in the same session against
 * separate threads:
 *
 *   1. Thread A (the session default, key `web:default`): we tell the
 *      assistant a unique phrase and ask it to acknowledge.
 *   2. Thread B (created via POST /threads): we ask the assistant to use
 *      `thread_read` against `web:default`, find the phrase, and report it.
 *
 * Asserts that thread B's final assistant message contains the original
 * phrase verbatim — proving:
 *   - POST /threads materializes a fresh engine thread
 *   - Messages routes correctly scope by threadId
 *   - The two threads do not share the same conversation history (B can't
 *     see the phrase in its own context — only via thread_read)
 *   - The engine's thread_read builtin works across threads in a session
 *
 * Skipped without `ANTHROPIC_API_KEY`.
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import { driveTurn } from "./_test-utils.js";
import type {
  CreateSessionResponse,
  CreateThreadResponse,
  ListMessagesResponse,
} from "../wire/types.js";

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

// A phrase chosen for low collision risk against any prompt boilerplate
// the model might emit on its own.
const SECRET_PHRASE = "pomegranate-orbital-1234";

describeIfKey("api integration: cross-thread reads", () => {
  it(
    "thread B can read thread A's messages via thread_read",
    async () => {
      const api = await bootTestApi();
      try {
        // 1. Create the session (default thread is web:default).
        const createSession = await fetch(`${api.baseUrl}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Virtual sandbox; workspace path doesn't need to exist on host
          // because the test uses VirtualSandboxProvider — but the workspace
          // route guard requires an absolute path, so use /tmp.
          body: JSON.stringify({ workspace: "/tmp" }),
        });
        expect(createSession.status).toBe(201);
        const { id: sessionId } = (await createSession.json()) as CreateSessionResponse;

        // 2. Drive thread A — agent acknowledges the phrase. We don't need
        //    a tool here; the phrase just needs to land in thread A's
        //    persisted message log so thread B can read it back.
        await driveTurn({
          baseUrl: api.baseUrl,
          wsUrl: api.wsUrl,
          sessionId,
          prompt:
            `Please remember this exact phrase verbatim: "${SECRET_PHRASE}". ` +
            "Reply with just the word 'noted' and nothing else.",
        });

        // 3. Create thread B.
        const createThread = await fetch(
          `${api.baseUrl}/api/sessions/${sessionId}/threads`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        expect(createThread.status).toBe(201);
        const threadB = (await createThread.json()) as CreateThreadResponse;

        // 4. Drive thread B — agent reads thread A and returns the phrase.
        //    B's own conversation does NOT contain the phrase, so the only
        //    way B can answer is via thread_read.
        await driveTurn({
          baseUrl: api.baseUrl,
          wsUrl: api.wsUrl,
          sessionId,
          threadId: threadB.id,
          prompt:
            "Use the thread_read tool with key 'web:default' to read messages " +
            "from the other thread in this session. There is a special phrase " +
            "the user asked the assistant to remember. Tell me what that phrase " +
            "is, copying it verbatim. Just the phrase, nothing else.",
        });

        // 5. Fetch thread B's messages and assert the assistant's last reply
        //    contains the phrase.
        const msgRes = await fetch(
          `${api.baseUrl}/api/sessions/${sessionId}/messages?threadId=${threadB.id}`,
        );
        expect(msgRes.status).toBe(200);
        const { messages } = (await msgRes.json()) as ListMessagesResponse;

        const assistantReplies = messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.content);

        expect(
          assistantReplies.some((reply) => reply.includes(SECRET_PHRASE)),
          `Thread B's assistant replies should mention "${SECRET_PHRASE}". ` +
            `Got: ${JSON.stringify(assistantReplies, null, 2)}`,
        ).toBe(true);

        // Also assert thread B's history is properly scoped: the user
        // message in B is the read-the-other-thread prompt (NOT the phrase
        // remember-this prompt from A). This catches a regression where
        // /messages?threadId= leaked across threads.
        const userMessages = messages.filter((m) => m.role === "user");
        expect(userMessages.length).toBeGreaterThan(0);
        expect(
          userMessages.every((m) => !m.content.includes("verbatim:")),
          `Thread B's user messages should not contain thread A's prompt. ` +
            `Got: ${JSON.stringify(userMessages.map((m) => m.content), null, 2)}`,
        ).toBe(true);
      } finally {
        await api.cleanup();
      }
    },
    // Two real Anthropic turns (~1.5s each) + tool call: budget 90s.
    90_000,
  );
});
