import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolvePromptAttachmentReferences } from "./attachment-refs.js";
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

describe("resolvePromptAttachmentReferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches runner attachment references over the session HTTP endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      type: "file",
      mime: "application/pdf",
      url: "data:application/pdf;base64,abc123",
      filename: "paper.pdf",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const attachments = await resolvePromptAttachmentReferences(
      [
        {
          type: "file",
          mime: "application/pdf",
          url: "valet-prompt-attachment://msg-1/0",
          filename: "paper.pdf",
        },
      ],
      "wss://api.example.com/api/sessions/session-1/ws?role=runner",
      "runner-token",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/sessions/session-1/runner-attachment?messageId=msg-1&index=0&token=runner-token",
    );
    expect(attachments).toEqual([
      {
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,abc123",
        filename: "paper.pdf",
      },
    ]);
  });

  it("fetches prompt blob references as raw bytes and converts them to data URLs", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fetchMock = vi.fn(async () => new Response(pdfBytes, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const attachments = await resolvePromptAttachmentReferences(
      [
        {
          type: "file",
          mime: "application/pdf",
          url: "valet-prompt-blob://attachment/session-1/blob-1",
          filename: "large.pdf",
        },
      ],
      "wss://api.example.com/api/sessions/session-1/ws?role=runner",
      "runner-token",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/sessions/session-1/runner-attachment?blobSessionId=session-1&blobId=blob-1&token=runner-token",
    );
    expect(attachments).toEqual([
      {
        type: "file",
        mime: "application/pdf",
        url: `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}`,
        filename: "large.pdf",
      },
    ]);
  });

  it("preserves runner attachment fetch failures as explicit attachment errors", async () => {
    const fetchMock = vi.fn(async () => new Response("missing", { status: 404, statusText: "Not Found" }));
    vi.stubGlobal("fetch", fetchMock);

    const attachments = await resolvePromptAttachmentReferences(
      [
        {
          type: "file",
          mime: "application/pdf",
          url: "valet-prompt-attachment://msg-missing/0",
          filename: "missing.pdf",
        },
      ],
      "wss://api.example.com/api/sessions/session-1/ws?role=runner",
      "runner-token",
    );

    expect(attachments?.[0]).toMatchObject({
      type: "file",
      mime: "application/pdf",
      filename: "missing.pdf",
    });
    expect(attachments?.[0]?.url).toMatch(/^valet-prompt-attachment-error:\/\/msg-missing\/0\?reason=/);
    expect(new URL(attachments?.[0]?.url ?? "").searchParams.get("reason")).toBe("404 Not Found");
  });
});
