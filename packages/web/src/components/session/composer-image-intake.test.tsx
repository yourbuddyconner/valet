// @vitest-environment jsdom
/**
 * Image intake in the composer: paste, drop, and the file picker all land
 * in the same held list, refusals are announced, and a sent message clears
 * the list.
 *
 * `IMAGE_ATTACHMENTS_ENABLED` is forced on here. The shipped value is false
 * until the send request carries attachments, so these tests describe the
 * behaviour the switch turns on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PromptImageAttachment } from "@valet/api/wire";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { useComposerDraftStore } from "~/stores/composer-drafts";

const sendMutateAsync = vi.fn().mockResolvedValue({ messageId: "q-1", threadId: "thread-1" });
// Typed with the store's real signature so `mock.calls` carries the
// argument tuple and the assertions below need no casts.
const addUserMessage = vi.fn(
  (_sessionId: string, _text: string, _threadId: string, _attachments?: PromptImageAttachment[]) => "user-opt-1",
);
const setMessageQueueItemId = vi.fn();

// importOriginal: see composer.test.tsx for why a bare replacement is
// unsafe here.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSendPrompt: () => ({ isPending: false, mutateAsync: sendMutateAsync }),
    useAbortThread: () => ({ isPending: false, mutateAsync: vi.fn(), mutate: vi.fn() }),
  };
});

vi.mock("~/stores/stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/stores/stream")>();
  return {
    ...actual,
    useStreamStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ addUserMessage, setMessageQueueItemId }),
    useQueueStateForThread: () => undefined,
  };
});

vi.mock("~/hooks/use-commands", () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));

vi.mock("./composer-images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./composer-images")>();
  return { ...actual, IMAGE_ATTACHMENTS_ENABLED: true };
});

import { Composer } from "./composer";

function renderComposer() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Composer sessionId="orchestrator:user-1" threadId="thread-1" agentStatus="idle" />
    </QueryClientProvider>,
  );
}

function png(name: string): File {
  return new File(["fake-bytes"], name, { type: "image/png" });
}

/**
 * Paste with a real event. `fireEvent.paste` cannot carry a clipboard
 * payload in jsdom, so the event is built and the payload defined on it.
 */
function pasteFiles(target: Element, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    },
  });
  fireEvent(target, event);
}

/** Drop with a real event, for the same reason as `pasteFiles`. */
function dropFiles(target: Element, files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files, dropEffect: "none" },
  });
  fireEvent(target, event);
}

beforeEach(() => {
  useComposerPrefillStore.setState({ text: null });
  // Drafts live in a module-global store keyed by (session, thread) — the
  // same key across tests would leak one test's chips into the next.
  useComposerDraftStore.setState({ byKey: {} });
  sendMutateAsync.mockClear();
  addUserMessage.mockClear();
});

describe("Composer — image intake", () => {
  it("attaches a pasted image and previews it", async () => {
    renderComposer();
    pasteFiles(screen.getByPlaceholderText(/Send a message/i), [png("pasted.png")]);
    await waitFor(() => expect(screen.getByAltText("pasted.png")).toBeDefined());
  });

  it("attaches a dropped image", async () => {
    const { container } = renderComposer();
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    dropFiles(form as HTMLFormElement, [png("dropped.png")]);
    await waitFor(() => expect(screen.getByAltText("dropped.png")).toBeDefined());
  });

  it("attaches images chosen with the file picker", async () => {
    const { container } = renderComposer();
    const input = container.querySelector("[data-testid=composer-image-input]");
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLInputElement, { target: { files: [png("picked.png")] } });
    await waitFor(() => expect(screen.getByAltText("picked.png")).toBeDefined());
  });

  it("routes an unsupported image type to the file-upload path", async () => {
    // Since sandbox file uploads shipped, a non-image file is not refused —
    // it becomes a file chip and uploads to the sandbox instead.
    renderComposer();
    const file = new File(["x"], "holiday.heic", { type: "image/heic" });
    pasteFiles(screen.getByPlaceholderText(/Send a message/i), [file]);
    await waitFor(() => {
      expect(screen.getByLabelText("Attached files").textContent).toContain("holiday.heic");
    });
    expect(screen.queryByAltText("holiday.heic")).toBeNull();
  });

  it("refuses an oversized image and names the limit", async () => {
    renderComposer();
    const big = new File(["x"], "huge.png", { type: "image/png" });
    // File size is derived from the content, so it is defined directly
    // rather than by building a 6 MB string.
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
    pasteFiles(screen.getByPlaceholderText(/Send a message/i), [big]);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("The limit is 5 MB for one image.");
    });
  });

  it("drops the refusal notice on request", async () => {
    renderComposer();
    // An oversized image produces the refusal; non-image types now route
    // to the file-upload path instead of a refusal.
    const big = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
    pasteFiles(screen.getByPlaceholderText(/Send a message/i), [big]);
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss image errors" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes a held image", async () => {
    renderComposer();
    pasteFiles(screen.getByPlaceholderText(/Send a message/i), [png("pasted.png")]);
    await waitFor(() => expect(screen.getByAltText("pasted.png")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Remove pasted.png" }));
    expect(screen.queryByAltText("pasted.png")).toBeNull();
  });

  it("sends images without requiring text", async () => {
    renderComposer();
    pasteFiles(screen.getByPlaceholderText(/Send a message/i), [png("pasted.png")]);
    await waitFor(() => expect(screen.getByAltText("pasted.png")).toBeDefined());
    const send = screen.getByRole("button", { name: /send/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ text: "", attachments: expect.arrayContaining([expect.objectContaining({ kind: "image" })]) })));
  });

  it("clears the held images after the message goes out", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Send a message/i);
    pasteFiles(textarea, [png("pasted.png")]);
    await waitFor(() => expect(screen.getByAltText("pasted.png")).toBeDefined());
    fireEvent.change(textarea, { target: { value: "look at this" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());
    expect(screen.queryByAltText("pasted.png")).toBeNull();
  });

  it("calls useSendPrompt with attachments when images are attached", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Send a message/i);
    pasteFiles(textarea, [png("shot.png")]);
    await waitFor(() => expect(screen.getByAltText("shot.png")).toBeDefined());
    fireEvent.change(textarea, { target: { value: "look at this" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());
    const arg = sendMutateAsync.mock.calls[0][0] as {
      text: string;
      attachments?: Array<{ kind: string; name: string; mimeType: string; url: string }>;
    };
    expect(arg.text).toBe("look at this");
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments![0]).toMatchObject({
      kind: "image",
      name: "shot.png",
      mimeType: "image/png",
    });
    expect(arg.attachments![0].url.startsWith("data:image/png")).toBe(true);
  });

  it("records attachments on the optimistic addUserMessage", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Send a message/i);
    pasteFiles(textarea, [png("shot.png")]);
    await waitFor(() => expect(screen.getByAltText("shot.png")).toBeDefined());
    fireEvent.change(textarea, { target: { value: "look at this" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(addUserMessage).toHaveBeenCalled());
    const args = addUserMessage.mock.calls[0];
    expect(args[0]).toBe("orchestrator:user-1");
    expect(args[1]).toBe("look at this");
    expect(args[2]).toBe("thread-1");
    expect(args[3]).toHaveLength(1);
    expect(args[3]?.[0]).toMatchObject({
      kind: "image",
      name: "shot.png",
    });
  });

  it("keeps the images when the send fails, so the user can retry", async () => {
    sendMutateAsync.mockRejectedValueOnce(new Error("network down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Send a message/i);
    pasteFiles(textarea, [png("pasted.png")]);
    await waitFor(() => expect(screen.getByAltText("pasted.png")).toBeDefined());
    fireEvent.change(textarea, { target: { value: "look at this" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByAltText("pasted.png")).toBeDefined());
    expect((textarea as HTMLTextAreaElement).value).toBe("look at this");
    errorSpy.mockRestore();
  });
});
