import type { PromptAttachment } from "./types.js";

const ATTACHMENT_REF_PREFIX = "valet-prompt-attachment://";
const ATTACHMENT_REF_ERROR_PREFIX = "valet-prompt-attachment-error://";

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function parseAttachmentRef(url: string): { messageId: string; index: number } | null {
  if (!url.startsWith(ATTACHMENT_REF_PREFIX)) return null;
  try {
    const parsed = new URL(url);
    const indexText = parsed.pathname.replace(/^\//, "");
    const index = Number.parseInt(indexText, 10);
    if (!parsed.hostname || !Number.isInteger(index) || index < 0) return null;
    return { messageId: decodeURIComponent(parsed.hostname), index };
  } catch {
    return null;
  }
}

function buildAttachmentFetchUrl(doUrl: string, runnerToken: string, messageId: string, index: number): string {
  const url = new URL(doUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/ws\/?$/, "/runner-attachment");
  url.search = "";
  url.searchParams.set("messageId", messageId);
  url.searchParams.set("index", String(index));
  url.searchParams.set("token", runnerToken);
  return url.toString();
}

function attachmentFetchErrorUrl(messageId: string, index: number, reason: string): string {
  const url = new URL(`${ATTACHMENT_REF_ERROR_PREFIX}${encodeURIComponent(messageId)}/${index}`);
  url.searchParams.set("reason", reason.slice(0, 500));
  return url.toString();
}

function redactedFetchUrl(fetchUrl: string): string {
  try {
    const url = new URL(fetchUrl);
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "[redacted]");
    }
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

export async function resolvePromptAttachmentReferences(
  attachments: PromptAttachment[] | undefined,
  doUrl: string,
  runnerToken: string,
): Promise<PromptAttachment[] | undefined> {
  if (!attachments?.length) return attachments;

  const refCount = attachments.filter((attachment) => parseAttachmentRef(attachment.url)).length;
  if (refCount > 0) {
    console.log(`[AgentClient] Resolving ${refCount}/${attachments.length} prompt attachment reference(s)`);
  }

  return Promise.all(attachments.map(async (attachment) => {
    const ref = parseAttachmentRef(attachment.url);
    if (!ref) return attachment;

    try {
      const fetchUrl = buildAttachmentFetchUrl(doUrl, runnerToken, ref.messageId, ref.index);
      console.log(`[AgentClient] Fetching prompt attachment ${ref.messageId}/${ref.index}: ${redactedFetchUrl(fetchUrl)}`);
      const res = await fetch(fetchUrl);
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const fetched = await res.json() as PromptAttachment;
      if (fetched?.type !== "file" || typeof fetched.mime !== "string" || typeof fetched.url !== "string") {
        throw new Error("invalid attachment payload");
      }
      console.log(
        `[AgentClient] Fetched prompt attachment ${ref.messageId}/${ref.index}: ` +
        `mime=${fetched.mime} filename=${fetched.filename || "unnamed"} urlChars=${fetched.url.length}`,
      );
      return fetched;
    } catch (err) {
      const reason = errorReason(err);
      console.error(`[AgentClient] Failed to fetch prompt attachment ${ref.messageId}/${ref.index}: ${reason}`, err);
      return {
        ...attachment,
        url: attachmentFetchErrorUrl(ref.messageId, ref.index, reason),
      };
    }
  }));
}
