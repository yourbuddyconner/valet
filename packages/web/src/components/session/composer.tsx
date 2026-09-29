import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Paperclip, Play, Square, X } from "lucide-react";
import { Button, Textarea } from "~/components/primitives";
import { useAbortThread, useResumeThread, useSendPrompt } from "~/api/queries";
import { ApiError } from "~/api/client";
import {
  queueBusy,
  useStreamStore,
  useQueueStateForThread,
  type AgentStatus,
  type StreamMessage,
} from "~/stores/stream";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { draftKey, useComposerDraft, useComposerDraftStore } from "~/stores/composer-drafts";
import { useCommands } from "~/hooks/use-commands";
import { cn } from "~/lib/cn";
import { useAutosizeTextarea } from "~/hooks/use-autosize-textarea";
import {
  readCommandRecency,
  recordCommandUse,
  type CommandRecency,
} from "~/lib/command-recency";
import { CommandPopup, commandsToItems, type PopupItem } from "./command-popup";
import { ComposerImageErrors, ComposerImageStrip } from "./composer-image-strip";
import { ComposerFileErrors, ComposerFileStrip } from "./composer-file-strip";
import { useComposerDrop } from "./composer-drop-context";
import {
  acceptImages,
  filesFromClipboard,
  filesFromList,
  isSupportedImageType,
  readFailure,
  readImage,
  toPromptAttachments,
  transferHasFiles,
  IMAGE_ACCEPT_ATTRIBUTE,
  IMAGE_ATTACHMENTS_ENABLED,
  MAX_IMAGES,
  type ComposerImage,
} from "./composer-images";
import {
  acceptFiles,
  createComposerFile,
  isFileUploading,
  toFileRefs,
  FILE_UPLOADS_ENABLED,
  MAX_FILES,
  type ComposerFile,
} from "./composer-files";
import { useFileUpload } from "~/hooks/use-file-upload";
import type { MessageReplyReference } from "@valet/api/wire";

/**
 * What the submit button does with the text in the composer.
 *
 * Mid-turn Enter queues (`followup`) even on a user orchestrator whose
 * thread default is `steer`. A second Enter on an empty composer promotes
 * that queued item into a steer. The engine thread default is left alone
 * so Slack and other channels can still steer on first submit.
 */
type SubmitAction = "send" | "steer" | "queue";

const ACTION_LABEL: Record<SubmitAction, string> = {
  send: "Send",
  steer: "Steer",
  queue: "Queue",
};

/**
 * One line of copy that tells the user what happens to the message. Shown
 * only while the agent works — while it is idle, "Send" needs no gloss.
 *
 * Mid-turn the first Enter queues. A second empty Enter promotes that
 * queued item into a steer (`Thread.promoteQueuedItem`) so the same
 * bubble becomes the new prompt. It does not POST the text again.
 */
const ACTION_HINT: Record<SubmitAction, string> = {
  send: "",
  steer: "Queued. Press Enter again, or select Send now above.",
  queue: "The agent completes the current turn. Then it reads your message.",
};

const ACTION_PLACEHOLDER: Record<SubmitAction, string> = {
  send: "Send a message…",
  steer: "Add another message…",
  queue: "Add a follow-up…",
};

export function Composer({
  sessionId,
  threadId,
  agentStatus,
  queuedMessages = [],
  queuedItemCount = 0,
  replyTarget,
  onCancelReply,
  beforeSend,
  onSent,
}: {
  beforeSend?: (text: string) => Promise<string>;
  onSent?: () => void;
  sessionId: string;
  /**
   * Active thread id. Required for sending — when undefined (threads still
   * loading), the composer is disabled. Without this, optimistic user
   * messages would have no thread tag and bleed into other threads' views
   * after a thread switch.
   */
  threadId?: string;
  agentStatus: AgentStatus;
  /** Pending user messages whose text is available, ordered by queue admission. */
  queuedMessages?: StreamMessage[];
  /** Durable pending item count. It can exceed queuedMessages after reload. */
  queuedItemCount?: number;
  replyTarget?: MessageReplyReference;
  onCancelReply?: () => void;
}) {
  // The draft (text, images, files, intake errors) lives in the per-thread
  // draft store, NOT component state: a draft typed for one thread must not
  // send to another, and an upload finishing after a thread switch must
  // still land in the thread it started on. See stores/composer-drafts.ts.
  // Store actions are reached through `getState()` inside handlers so
  // callback identities do not churn per keystroke.
  const key = draftKey(sessionId, threadId);
  const { text, images, files, imageErrors, fileErrors } = useComposerDraft(key);
  const setText = (value: string) => useComposerDraftStore.getState().setText(key, value);
  const submitting = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [selected, setSelected] = useState(false);
  useAutosizeTextarea(inputRef, text);
  useEffect(() => {
    if (replyTarget) inputRef.current?.focus();
  }, [replyTarget]);

  // Composer-prefill handoff (decision 17): memory doc's "Ask {name} to
  // update this" sets this store then navigates to `/chat`; the next
  // Composer to mount consumes it exactly once into the active draft slot.
  // Reading via `getState()` (not the hook) so this is a one-time seed, not
  // a live subscription — a later `set()` elsewhere shouldn't yank the
  // draft out from under whatever the user is typing.
  const prefillSeeded = useRef(false);
  useEffect(() => {
    if (prefillSeeded.current) return;
    prefillSeeded.current = true;
    const pending = useComposerPrefillStore.getState().consume();
    if (pending !== null) useComposerDraftStore.getState().setText(key, pending);
  }, [key]);
  // This Composer can mount before the threads query resolves (threadId
  // undefined) — typing and the prefill land in the session's no-thread
  // slot. Adopt that slot into the real thread once it is known, so the
  // draft does not silently vanish when `key` changes.
  useEffect(() => {
    if (threadId === undefined) return;
    useComposerDraftStore.getState().adoptOrphanDraft(sessionId, threadId);
  }, [sessionId, threadId]);

  const { uploadFile } = useFileUpload(sessionId);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Form element ref for the page-level drop target — used to skip
  // double-intake when a drop already landed on the composer's form
  // (which has its own `onDrop` handler).
  const formRef = useRef<HTMLFormElement>(null);
  // Drag events fire for every child element the pointer crosses, so a
  // single `dragleave` does not mean the pointer left the composer. Count
  // enter and leave, and clear the highlight only at zero.
  const dragDepth = useRef(0);

  // Slash-command autocomplete: two popup modes derived from the text.
  // COMMAND mode while the message is a lone "/token"; ARGUMENT mode while it
  // is "/command <partial-first-arg>" and the command enumerates completions
  // (e.g. /model's model ids). Dispatch remains server-side; the composer
  // sends text unchanged.
  const commandQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  const argMatch = /^\/(\S+) (\S*)$/.exec(text);
  const { data: commandsData } = useCommands(sessionId);
  const allCommands = commandsData?.commands ?? [];
  // Per-browser last-used ranking for the command popup. Loaded once per
  // mount; `submit` records each sent slash command and refreshes it.
  const [commandRecency, setCommandRecency] = useState<CommandRecency>(() => readCommandRecency());
  // COMMAND mode hands the raw registry and the typed token to
  // `commandsToItems`, the single owner of popup matching and ranking
  // (case-insensitive substring match, tiered exact > prefix > substring,
  // then recency) — see command-popup.tsx.
  // The ARGUMENT-mode lookup is case-insensitive to match the popup and
  // the engine's case-insensitive dispatch.
  const argCommand = argMatch
    ? allCommands.find((c) => c.name.toLowerCase() === argMatch[1].toLowerCase())
    : undefined;
  const argPrefix = argMatch?.[2] ?? "";
  const argOptions = argCommand?.argOptions ?? [];
  const argPrefixLower = argPrefix.toLowerCase();
  const filteredArgs = argCommand
    ? argOptions.filter((o) => {
        if (argPrefixLower === "") return true;
        // Match the full value, the value after a provider prefix
        // ("anthropic/claude-…" ⇒ "claude-…"), or the display label —
        // users type "claude-o" or "opus", not "anthropic/claude-o".
        const v = o.value.toLowerCase();
        const tail = v.slice(v.indexOf("/") + 1);
        return (
          v.startsWith(argPrefixLower) ||
          tail.startsWith(argPrefixLower) ||
          (o.label?.toLowerCase().includes(argPrefixLower) ?? false)
        );
      })
    : [];
  const popupItems: PopupItem[] =
    commandQuery !== null
      ? commandsToItems(allCommands, commandRecency, commandQuery)
      : filteredArgs.map((o) => ({
          id: o.value,
          label: o.value,
          detail: o.label,
          group: "Arguments",
        }));
  // A command whose first argument is free text (argHint, no options) gets a
  // passive hint row while the argument is still empty — discoverability
  // without pretending we can complete it.
  const argNotice =
    argCommand && argOptions.length === 0 && argPrefix === "" && argCommand.argHint
      ? argCommand.argHint
      : undefined;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const popupOpen = !dismissed && popupItems.length > 0;
  const noticeOpen = !dismissed && !popupOpen && argNotice !== undefined;
  // Reset selection and dismissed flag when the query changes (user typed new chars).
  useEffect(() => {
    setSelectedIndex(0);
    setDismissed(false);
  }, [popupItems.length, commandQuery, argPrefix]);
  // Focus-on-request (New thread button): reactive on purpose, unlike the
  // prefill text — the Composer is usually already mounted when the
  // request fires, so a mount-time consume would miss it.
  const focusNonce = useComposerPrefillStore((s) => s.focusNonce);
  useEffect(() => {
    if (focusNonce > 0) inputRef.current?.focus();
  }, [focusNonce]);
  // Prefill for a Composer that is ALREADY mounted (the workflow editor's
  // assistant panel sits open beside the canvas, so its suggestions never
  // get a fresh mount to seed). The initializer above still covers the
  // navigate-then-mount handoff: it consumes first, which leaves nothing
  // here to read, so this effect no-ops on mount instead of double-seeding.
  const prefillNonce = useComposerPrefillStore((s) => s.prefillNonce);
  useEffect(() => {
    if (prefillNonce === 0) return;
    const pending = useComposerPrefillStore.getState().consume();
    if (pending === null) return;
    setText(pending);
    inputRef.current?.focus();
  }, [prefillNonce]);
  const send = useSendPrompt(sessionId);
  const abort = useAbortThread(sessionId);
  const resume = useResumeThread(sessionId);
  // The textarea disables while a send is in flight, which drops focus to
  // <body>. Refocus when the send settles so the user can type the next
  // message or command immediately (covers Enter sends and Send clicks).
  const sendWasPending = useRef(false);
  useEffect(() => {
    if (sendWasPending.current && !send.isPending) inputRef.current?.focus();
    sendWasPending.current = send.isPending;
  }, [send.isPending]);
  const addUserMessage = useStreamStore((s) => s.addUserMessage);
  const setMessageQueueItemId = useStreamStore((s) => s.setMessageQueueItemId);
  const queueState = useQueueStateForThread(sessionId, threadId);
  // Last followup this composer admitted, keyed by thread so a switch does
  // not arm Steer with another thread's item. An empty Enter promotes that
  // item; a new typed message queues another.
  const [queuedFollowupByThread, setQueuedFollowupByThread] = useState<
    Record<string, { localId: string; itemId: string }>
  >({});
  const queuedFollowup = threadId ? (queuedFollowupByThread[threadId] ?? null) : null;
  // Item ids we have seen in `pendingIds`. Used so a lagging queue.state
  // (empty pending after POST) does not disarm Steer before the item lands.
  const followupSeenPendingRef = useRef<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [promotingItemId, setPromotingItemId] = useState<string | null>(null);
  const unresolvedQueuedCount = Math.max(0, queuedItemCount - queuedMessages.length);

  // A mid-turn message is allowed — the engine admits it either way. Only
  // an in-flight POST or an unknown thread id blocks submit, and the thread
  // id is mandatory because the optimistic message carries it.
  //
  // `working` gates the Stop button and the Escape interrupt, so it must be
  // true for the WHOLE time the agent holds the execution context — not just
  // while status transition events happen to be flowing. `agentStatus` alone
  // misses two windows: a client that connected mid-turn before the WS
  // handshake seeded it, and any state the live events dropped. The queue
  // state is the durable fallback: a running/blocked/queued submission means
  // there is something to abort.
  const working =
    (agentStatus !== "idle" && agentStatus !== "error") || queueBusy(queueState);
  useEffect(() => {
    if (!threadId) return;
    setQueuedFollowupByThread((prev) => {
      const current = prev[threadId];
      if (!current) return prev;
      const drop = () => {
        delete followupSeenPendingRef.current[threadId];
        const { [threadId]: _, ...rest } = prev;
        return rest;
      };
      if (!working) return drop();
      const pending = queueState?.pendingIds ?? [];
      if (pending.includes(current.itemId)) {
        followupSeenPendingRef.current[threadId] = current.itemId;
      }
      const claimed = queueState?.activeItemId === current.itemId;
      const seen = followupSeenPendingRef.current[threadId] === current.itemId;
      const leftQueue = seen && !pending.includes(current.itemId);
      if (claimed || leftQueue) return drop();
      return prev;
    });
  }, [working, queueState, threadId]);
  // Mid-turn: first Enter queues. After a self-queued item, an empty
  // composer steers that item in place. New text queues another followup.
  const action: SubmitAction = !working
    ? "send"
    : queuedFollowup && text.trim().length === 0 && images.length === 0 && files.length === 0
      ? "steer"
      : "queue";
  // A send with a still-uploading file would drop it (the ref does not
  // exist yet), so the button waits for the uploads. Steer is the empty
  // Enter that promotes the already-queued item, so it does not need text.
  const uploadsPending = files.some(isFileUploading);
  const canSend =
    !send.isPending &&
    !!threadId &&
    !uploadsPending &&
    (action === "steer" || text.trim().length > 0 || images.length > 0 || toFileRefs(files).length > 0);
  const sendTitle = working ? ACTION_HINT[action] : uploadsPending ? "Wait for the file uploads to finish." : undefined;

  /** True while the composer refuses new files. */
  const intakeBlocked =
    (!IMAGE_ATTACHMENTS_ENABLED && !FILE_UPLOADS_ENABLED) || send.isPending || !threadId;

  /**
   * Take files from a paste, a drop, or the picker. Refused files leave a
   * message; accepted files are read into `data:` URLs for the preview and
   * for the request body.
   *
   * Wrapped in `useCallback` so the identity survives across renders — the
   * page-level drop target reads this via the ComposerDropContext, and a
   * stable callback keeps the intake object it publishes stable too.
   */
  /** Kick off one upload and fold its result back into the draft slot the
   * upload STARTED in — the user may switch threads while it runs, and the
   * result must not follow them. A file removed mid-upload maps to nothing
   * — the result is dropped. */
  const startUpload = useCallback(
    (slot: string, composerFile: ComposerFile) => {
      void uploadFile(composerFile).then((updated) => {
        useComposerDraftStore
          .getState()
          .setFiles(slot, (prev) => prev.map((f) => (f.id === composerFile.id ? updated : f)));
      });
    },
    [uploadFile],
  );

  const addFiles = useCallback(
    async (incoming: File[]) => {
      if (intakeBlocked || incoming.length === 0) return;
      const drafts = useComposerDraftStore.getState();
      // Supported image types keep the inline data-URL path; everything
      // else uploads to the sandbox. With uploads disabled, every file
      // goes through the image intake so an unsupported type still earns
      // a message instead of vanishing.
      const imageFiles = FILE_UPLOADS_ENABLED
        ? incoming.filter((f) => isSupportedImageType(f.type))
        : incoming;
      const uploadable = FILE_UPLOADS_ENABLED
        ? incoming.filter((f) => !isSupportedImageType(f.type))
        : [];

      if (uploadable.length > 0) {
        const held = drafts.byKey[key]?.files ?? [];
        const { accepted, rejected } = acceptFiles(held, uploadable);
        drafts.setFileErrors(key, rejected);
        const created = accepted.map(createComposerFile);
        if (created.length > 0) {
          // Cap re-applied at the state edge, mirroring the image intake.
          drafts.setFiles(key, (prev) => [...prev, ...created].slice(0, MAX_FILES));
          created.forEach((f) => startUpload(key, f));
        }
      }

      if (imageFiles.length === 0) return;
      const held = drafts.byKey[key]?.images ?? [];
      const { accepted, rejected } = acceptImages(held, imageFiles);
      drafts.setImageErrors(key, rejected);
      const read: ComposerImage[] = [];
      const failures: string[] = [];
      for (const file of accepted) {
        try {
          read.push(await readImage(file));
        } catch (err) {
          failures.push(err instanceof Error ? err.message : readFailure(file.name));
        }
      }
      if (failures.length > 0) drafts.setImageErrors(key, (prev) => [...prev, ...failures]);
      if (read.length === 0) return;
      // `acceptImages` ran against the state this call captured. A second
      // intake that overlaps this one (a drop while a paste still reads)
      // would push past the cap, so the cap is applied again at the state
      // edge, where the real list is.
      drafts.setImages(key, (prev) => [...prev, ...read].slice(0, MAX_IMAGES));
    },
    [intakeBlocked, startUpload, key],
  );

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (intakeBlocked) return;
    const files = filesFromClipboard(e.clipboardData?.items);
    if (files.length === 0) return;
    // A pasted screenshot must not also drop its file name into the text.
    e.preventDefault();
    void addFiles(files);
  }

  function onDragEnter(e: DragEvent<HTMLFormElement>) {
    if (intakeBlocked || !transferHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }

  function onDragOver(e: DragEvent<HTMLFormElement>) {
    if (intakeBlocked || !transferHasFiles(e.dataTransfer?.types)) return;
    // Without this the browser refuses the drop and opens the file instead.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent<HTMLFormElement>) {
    if (intakeBlocked || !transferHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }

  function onDrop(e: DragEvent<HTMLFormElement>) {
    if (intakeBlocked || !transferHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    void addFiles(filesFromList(e.dataTransfer.files));
  }

  function onPickFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = filesFromList(e.target.files);
    // Clear the input so the same file can be chosen again later.
    e.target.value = "";
    void addFiles(files);
  }

  function removeImage(id: string) {
    useComposerDraftStore.getState().setImages(key, (prev) => prev.filter((image) => image.id !== id));
  }

  function removeFile(id: string) {
    useComposerDraftStore.getState().setFiles(key, (prev) => prev.filter((f) => f.id !== id));
  }

  function retryFile(id: string) {
    const drafts = useComposerDraftStore.getState();
    const target = (drafts.byKey[key]?.files ?? []).find((f) => f.id === id);
    if (!target) return;
    // A fresh ComposerFile (no error, no ref) reads as "uploading" again.
    const reset: ComposerFile = {
      id: target.id,
      name: target.name,
      bytes: target.bytes,
      file: target.file,
    };
    drafts.setFiles(key, (prev) => prev.map((f) => (f.id === id ? reset : f)));
    startUpload(key, reset);
  }

  async function promoteQueuedItem(itemId: string, messageId: string) {
    if (send.isPending || !threadId) return;
    setSubmitError(null);
    setPromotingItemId(itemId);
    try {
      const res = await send.mutateAsync({ text: "", threadId, promoteItemId: itemId });
      if (res.messageId && res.messageId !== itemId) {
        setMessageQueueItemId(sessionId, messageId, res.messageId);
      }
      if (queuedFollowup?.itemId === itemId) {
        setQueuedFollowupByThread((prev) => {
          if (!(threadId in prev)) return prev;
          const { [threadId]: _, ...rest } = prev;
          return rest;
        });
        delete followupSeenPendingRef.current[threadId];
      }
    } catch (err) {
      setSubmitError(
        apiErrorDetail(
          err,
          "The message was not sent. Send a new message, or wait for the current turn to finish.",
        ),
      );
    } finally {
      setPromotingItemId(null);
    }
  }

  async function submit() {
    if (submitting.current || send.isPending || !threadId || uploadsPending) return;

    // Empty Enter after a self-queued followup promotes that item. Do not
    // POST the same text again — that would write a second user entry.
    if (action === "steer" && queuedFollowup) {
      await promoteQueuedItem(queuedFollowup.itemId, queuedFollowup.localId);
      return;
    }

    const t = text.trim();
    if (!t && images.length === 0 && toFileRefs(files).length === 0) return;
    setSubmitError(null);
    // Capture the draft slot at send time: the failure path below must
    // restore into the thread the message was written for, even if the
    // user switches threads while the POST is in flight.
    const slot = key;
    // Held images go with the message. Convert them to the wire format
    // and pass them in the request body.
    const pendingImages = images;
    const attachments = pendingImages.length > 0 ? toPromptAttachments(pendingImages) : undefined;
    // Uploaded files ride as refs; a file whose upload failed is dropped
    // (its chip showed the error and offered a retry before send).
    const pendingFiles = files;
    const fileRefs = toFileRefs(pendingFiles);
    useComposerDraftStore.getState().clear(slot);
    // Optimistic local add — the engine doesn't emit a wire event for the
    // user's own message, so without this the prompt would only appear after
    // the next WS init (page reload). The next init replaces this row with
    // the server's persisted copy. File chips are not rendered optimistically
    // — the server owns their sandbox paths; they appear on the next init.
    const localId = addUserMessage(sessionId, t, threadId, attachments, replyTarget);
    submitting.current = true;
    setPreparing(true);
    try {
      const preparedText = beforeSend ? await beforeSend(t) : t;
      const res = await send.mutateAsync({
        text: preparedText,
        threadId,
        attachments,
        fileRefs: fileRefs.length > 0 ? fileRefs : undefined,
        ...(replyTarget ? { replyToMessageId: replyTarget.messageId } : {}),
        ...(working ? { queueMode: "followup" as const } : {}),
      });
      // `messageId` on the response is the engine's queue item id (see
      // POST /:id/messages). Stamping it closes the linkage so
      // `submission.settled` can match this exact message instead of
      // falling back to a recency heuristic. Null for slash commands —
      // they never queue, so there is nothing to link.
      onCancelReply?.();
      if (res.messageId) {
        const itemId = res.messageId;
        setMessageQueueItemId(sessionId, localId, itemId);
        if (working) {
          setQueuedFollowupByThread((prev) => ({
            ...prev,
            [threadId]: { localId, itemId },
          }));
        }
      }
      onSent?.();
      // Recency ranking for the command popup. Recorded only for a name the
      // registry knows, and only after the send succeeded — a typo or a
      // failed send is not a "use". Matched case-insensitively (dispatch
      // is too) and recorded under the canonical name so the recency key
      // always lines up with the popup's names.
      const typedName = /^\/(\S+)/.exec(t)?.[1]?.toLowerCase();
      const canonical = typedName
        ? allCommands.find((c) => c.name.toLowerCase() === typedName)?.name
        : undefined;
      if (canonical) {
        setCommandRecency(recordCommandUse(canonical));
      }
    } catch (err) {
      // Restore the draft on failure so the user can retry — into `slot`,
      // the thread it was written for. The optimistic message stays
      // visible — they can see what they sent + retry; on the next reload
      // it'll be reconciled against server truth. The server restores
      // consumed refs when a submit fails, so restored chips stay sendable
      // — EXCEPT when the failure is the refs themselves.
      const drafts = useComposerDraftStore.getState();
      drafts.setText(slot, t);
      drafts.setImages(slot, pendingImages);
      const payload =
        err instanceof ApiError && typeof err.payload === "object" && err.payload !== null
          ? (err.payload as Record<string, unknown>)
          : undefined;
      // An unknown-attachment 400 means a ref is dead (15-minute TTL, or an
      // api restart emptied the ref store). A restored chip must not read
      // as uploaded: flip uploaded chips to the error state, whose retry
      // button re-uploads the held File and mints a fresh ref.
      const refsDead =
        err instanceof ApiError &&
        err.status === 400 &&
        typeof payload?.error === "string" &&
        payload.error.startsWith("unknown attachment");
      drafts.setFiles(
        slot,
        refsDead
          ? pendingFiles.map((f) =>
              f.attachmentRef !== undefined
                ? { ...f, attachmentRef: undefined, error: "Upload expired. Retry to upload again." }
                : f,
            )
          : pendingFiles,
      );
      // The failure must be visible — a console-only error reads as a dead
      // send button.
      const detail =
        typeof payload?.corrective === "string"
          ? payload.corrective
          : typeof payload?.error === "string"
            ? payload.error
            : err instanceof Error
              ? err.message
              : "Unknown error.";
      drafts.setFileErrors(slot, [`The message did not send. ${detail}`]);
      console.error("send failed:", err);
    } finally {
      submitting.current = false;
      setPreparing(false);
    }
  }

  async function stop() {
    const targetItemId = queueState?.activeItemId;
    if (!threadId || !targetItemId || abort.isPending) return;
    try {
      await abort.mutateAsync({ threadId, targetItemId });
    } catch (err) {
      console.error("abort failed:", err);
    }
  }

  async function runQueue() {
    if (!threadId || resume.isPending) return;
    setSubmitError(null);
    try {
      await resume.mutateAsync({ threadId });
    } catch (err) {
      setSubmitError(apiErrorDetail(err, "The queue did not start. Try again."));
    }
  }

  // Escape interrupts the running turn — parity with the Stop button —
  // from anywhere on the chat tab, not just the textarea. Window-level
  // because focus often sits outside the textarea mid-turn (it disables
  // while a send is in flight). Layered dismissals keep priority: any
  // handler that claims Escape first (the command popup above, the child
  // panel's close) calls preventDefault, and a claimed event is skipped.
  const abortMutate = abort.mutate;
  const abortPending = abort.isPending;
  useEffect(() => {
    function onEscape(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const targetItemId = queueState?.activeItemId;
      if (!working || !threadId || !targetItemId || abortPending) return;
      e.preventDefault();
      abortMutate(
        { threadId, targetItemId },
        { onError: (err) => console.error("abort failed:", err) },
      );
    }
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [working, threadId, queueState?.activeItemId, abortPending, abortMutate]);

  function insertSelection(id: string) {
    if (commandQuery !== null) {
      setText(`/${id} `);
    } else if (argCommand) {
      setText(`/${argCommand.name} ${id} `);
    }
    setSelectedIndex(0);
    // Mouse selection would otherwise leave focus off the textarea.
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // While the popup is open, intercept navigation keys. IME composition
    // guard applies here too — composition events must not trigger navigation.
    if (popupOpen && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, popupItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        insertSelection(popupItems[selectedIndex].id);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Mark dismissed — the popup closes without modifying the text.
        // dismissed resets automatically when commandQuery changes (user types).
        setDismissed(true);
        return;
      }
      if (e.key === "Enter") {
        // Confirm selection — do NOT send.
        if (e.shiftKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        insertSelection(popupItems[selectedIndex].id);
        return;
      }
    }

    // Enter submits; Shift+Enter inserts a newline. Skip while an IME
    // composition is active so Enter confirms the composition instead of
    // sending a half-finished message.
    if (e.key !== "Enter") return;
    if (e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  }

  // Publish the intake pipeline to SessionView's ComposerDropContext, so
  // the page-level drop target can hand off files dropped anywhere on the
  // chat tab. Republish whenever the callback identity or the blocked flag
  // changes; clear on unmount so a stale intake is never called.
  const dropChannel = useComposerDrop();
  useEffect(() => {
    if (!dropChannel) return;
    dropChannel.publish({
      addFiles: (files) => void addFiles(files),
      blocked: intakeBlocked,
      ownedEl: formRef.current,
    });
    return () => dropChannel.publish(null);
  }, [dropChannel, addFiles, intakeBlocked]);

  // Removing a focused attachment action does not emit blur in every browser.
  // Reconcile selection after DOM updates and the submission focus restoration.
  useEffect(() => {
    if (selected && !send.isPending && !formRef.current?.contains(document.activeElement)) {
      setSelected(false);
    }
  });

  const expanded =
    selected ||
    text.length > 0 ||
    images.length > 0 ||
    files.length > 0 ||
    !!replyTarget ||
    imageErrors.length > 0 ||
    fileErrors.length > 0 ||
    Boolean(submitError) ||
    dragActive ||
    send.isPending;

  return (
    <form
      ref={formRef}
      data-expanded={expanded}
      onMouseDownCapture={(event) => {
        // Safari does not focus buttons on pointer activation. Focus them before
        // the textarea blurs, so its action row cannot move during the click.
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        if (button && !button.disabled && event.button === 0) {
          event.preventDefault();
          button.focus({ preventScroll: true });
        }
      }}
      onBlurCapture={(event) => {
        // Keep action targets in place while focus moves within the composer.
        // Submission temporarily disables the input before restoring its focus.
        if (!event.currentTarget.contains(event.relatedTarget) && !send.isPending) {
          setSelected(false);
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "mx-auto w-full max-w-[52rem] flex min-h-0 flex-col px-5 pt-3 sm:px-8 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-paper",
        dragActive && "ring-2 ring-inset ring-moss",
      )}
    >
      {(queuedMessages.length > 0 || unresolvedQueuedCount > 0) && (
        <div className="mb-2 space-y-1.5" aria-label="Queued messages">
          {queuedMessages.map((message) => {
            const itemId = message.queueItemId;
            if (!itemId) return null;
            return (
              <div
                key={itemId}
                className="flex items-center gap-2 rounded-xl border border-line bg-ink-wash px-3 py-2 text-xs"
              >
                <p className="min-w-0 flex-1 line-clamp-2 text-ink">{message.content}</p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  disabled={send.isPending}
                  onClick={() => void promoteQueuedItem(itemId, message.id)}
                >
                  {promotingItemId === itemId ? "Sending…" : "Send now"}
                </Button>
              </div>
            );
          })}
          {unresolvedQueuedCount > 0 && (
            <p className="px-1 text-xs text-muted" role="status">
              {unresolvedQueuedCount} queued{" "}
              {unresolvedQueuedCount === 1 ? "message is" : "messages are"} waiting.
            </p>
          )}
        </div>
      )}
      <div
        className={cn(
          "flex min-h-0 flex-col rounded-2xl border border-line bg-paper shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-moss focus-within:ring-4 focus-within:ring-moss-wash motion-reduce:transition-none",
          expanded ? "p-2" : "p-1",
        )}
      >
        <QueueIndicator queueState={queueState} />
        {replyTarget && (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-line bg-moss-wash px-3 py-2 text-xs">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">Replying to Assistant</p>
              <p className="mt-0.5 line-clamp-2 text-muted">{replyTarget.excerpt}</p>
            </div>
            <button
              type="button"
              onClick={onCancelReply}
              className="rounded p-1 text-muted hover:text-ink"
              aria-label="Cancel reply"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}
        {dragActive && (
          <p className="mb-2 px-3 pt-1 text-xs leading-5 text-muted">
            {FILE_UPLOADS_ENABLED ? "Drop the files to attach them." : "Drop the images to attach them."}
          </p>
        )}
        <ComposerImageErrors
          messages={imageErrors}
          onDismiss={() => useComposerDraftStore.getState().setImageErrors(key, [])}
        />
        <ComposerImageStrip images={images} onRemove={removeImage} />
        <ComposerFileErrors
          messages={fileErrors}
          onDismiss={() => useComposerDraftStore.getState().setFileErrors(key, [])}
        />
        <ComposerFileErrors
          messages={submitError ? [submitError] : []}
          onDismiss={() => setSubmitError(null)}
        />
        <ComposerFileStrip files={files} onRemove={removeFile} onRetry={retryFile} />
        {working && <p className="mb-2 px-3 pt-1 text-xs leading-5 text-muted">{ACTION_HINT[action]}</p>}
        {/* `relative` anchors the command popup to the input row, so the hint
            above it never moves the popup. */}
        <div className={cn("relative flex min-h-0", expanded ? "flex-col" : "items-end")}>
          {(popupOpen || noticeOpen) && (
            <CommandPopup
              items={popupOpen ? popupItems : []}
              notice={argNotice}
              ariaLabel={
                commandQuery !== null
                  ? `Slash command suggestions for /${commandQuery}`
                  : `Argument suggestions for /${argCommand?.name ?? ""}`
              }
              selectedIndex={selectedIndex}
              onSelect={insertSelection}
              onHover={setSelectedIndex}
            />
          )}
          <Textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setSelected(true)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={threadId ? ACTION_PLACEHOLDER[action] : "Loading thread…"}
            aria-label="Message"
            rows={1}
            className={cn(
              "block w-full min-w-0 resize-none overflow-y-auto overscroll-contain rounded-none border-0 bg-transparent px-3 text-base leading-6 shadow-none caret-moss focus-visible:border-transparent focus-visible:ring-0 max-sm:rounded-none max-sm:px-3 max-sm:shadow-none max-sm:focus-visible:ring-0",
              expanded
                ? "min-h-20 max-h-[min(14rem,35dvh)] py-3 max-sm:py-3"
                : "min-h-11 max-h-11 flex-1 py-2.5 max-sm:py-2.5",
            )}
            disabled={preparing || send.isPending || !threadId}
          />
          <div className={cn("flex shrink-0 items-center gap-2", expanded && "px-1 pb-1 pt-1")}>
            {(IMAGE_ATTACHMENTS_ENABLED || FILE_UPLOADS_ENABLED) && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  // With file uploads on, the picker accepts anything; images
                  // still route to the inline image path in `addFiles`.
                  accept={FILE_UPLOADS_ENABLED ? undefined : IMAGE_ACCEPT_ATTRIBUTE}
                  multiple
                  className="hidden"
                  onChange={onPickFiles}
                  data-testid="composer-image-input"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="h-11 w-11 shrink-0 rounded-xl p-0 text-muted hover:text-ink"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={intakeBlocked}
                  aria-label={FILE_UPLOADS_ENABLED ? "Attach files" : "Attach images"}
                  title={FILE_UPLOADS_ENABLED ? "Attach files" : "Attach images"}
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
              </>
            )}
            <span className={cn("min-w-0 flex-1 text-xs text-muted", !expanded && "hidden")}>
              <span className="hidden sm:inline">
                Enter to {ACTION_LABEL[action].toLowerCase()} · Shift+Enter for a new line
              </span>
            </span>
            {working && queueState?.activeItemId && (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className={cn(
                  "h-11 shrink-0 rounded-full text-danger-600 hover:text-danger-500 dark:text-danger-500",
                  expanded ? "px-3" : "w-11 p-0",
                )}
                onClick={() => void stop()}
                disabled={!threadId || abort.isPending}
                aria-label="Stop"
                title="Stop (Esc)"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                <span className={cn(!expanded && "sr-only")}>Stop</span>
              </Button>
            )}
            {working && !queueState?.activeItemId && (queueState?.pendingIds.length ?? 0) > 0 && (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className={cn("h-11 shrink-0 rounded-full", expanded ? "px-3" : "w-11 p-0")}
                onClick={() => void runQueue()}
                disabled={!threadId || resume.isPending}
                aria-label="Run queued messages"
                title="Run queued messages"
              >
                <Play className="h-3.5 w-3.5 fill-current" aria-hidden />
                <span className={cn(!expanded && "sr-only")}>Run queue</span>
              </Button>
            )}
            <Button
              type="submit"
              disabled={preparing || !canSend}
              size="lg"
              title={sendTitle}
              className={cn(
                "h-11 shrink-0 rounded-full transition-colors motion-reduce:transition-none",
                expanded ? "px-4" : "w-11 p-0",
                !canSend && "bg-ink-wash text-muted disabled:opacity-100",
              )}
            >
              <ArrowUp className="h-4 w-4" aria-hidden />
              <span className={cn(!expanded && "sr-only")}>{ACTION_LABEL[action]}</span>
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function apiErrorDetail(err: unknown, fallback: string): string {
  const payload =
    err instanceof ApiError && typeof err.payload === "object" && err.payload !== null
      ? (err.payload as Record<string, unknown>)
      : undefined;
  if (typeof payload?.corrective === "string") return payload.corrective;
  if (typeof payload?.error === "string") return payload.error;
  if (err instanceof Error && err.message.length > 0) return err.message;
  return fallback;
}

/**
 * Small text indicator above the composer for the thread's submission
 * queue. `blocked_on_decision_gate` is intentionally NOT surfaced here —
 * the `DecisionGateCard` already renders "agent paused" for that state, and
 * showing it twice would be redundant.
 */
function QueueIndicator({
  queueState,
}: {
  queueState: ReturnType<typeof useQueueStateForThread>;
}) {
  const collecting = (queueState?.collectingIds.length ?? 0) > 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!collecting) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [collecting]);

  if (!queueState) return null;
  const parts: string[] = [];
  if (collecting) {
    const count = queueState.collectingIds.length;
    const messages = count === 1 ? "message" : "messages";
    const deadline = queueState.collectDeadline;
    const seconds = deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - now) / 1_000));
    const wait = seconds === undefined ? "when the collection window ends" : `in about ${seconds} seconds`;
    const canStopActive = queueState.activeItemId !== undefined;
    parts.push(
      canStopActive
        ? `Collecting ${count} ${messages}; they run together ${wait}. Stop affects only the active message.`
        : `Collecting ${count} ${messages}; they run together ${wait}. The collection cannot be stopped.`,
    );
  }
  if (queueState.status === "paused") {
    parts.push("Paused");
  }
  if (parts.length === 0) return null;
  return (
    <div role="status" className="mb-2 px-3 pt-1 text-xs leading-5 text-muted">{parts.join(" • ")}</div>
  );
}
