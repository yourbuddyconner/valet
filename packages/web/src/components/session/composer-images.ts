/**
 * Image intake for the composer: which files the client accepts, why it
 * refuses the rest, and the payload shape a send request needs.
 *
 * Everything here is pure or DOM-agnostic. The event plumbing (paste, drop,
 * file picker) stays in `composer.tsx`; every decision about whether a file
 * is usable lives here, so it is testable without a browser.
 *
 * The `PromptImageAttachment` type is exported from `@valet/api/wire`;
 * see `packages/api/src/wire/types.ts`.
 */

import { formatBytes as formatSize } from "@valet/shared";
import type { PromptImageAttachment } from "@valet/api/wire";

/**
 * Master switch for the image affordances in the composer.
 *
 * The send request (`SendPromptRequest`, `packages/api/src/wire/types.ts`)
 * now carries `attachments` when images are attached. An affordance that
 * cannot finish its job is worse than no affordance at all: the user
 * attaches a picture, sends the message, and the agent silently never
 * sees it. This flag gates the affordance until the engine has image
 * support end-to-end.
 *
 * To turn the feature on:
 * 1. Add `attachments?: PromptImageAttachment[]` to `SendPromptRequest` ✓
 * 2. Relay `attachments` through `api.sendPrompt` and `useSendPrompt` ✓
 * 3. Implement engine-side image handling in message construction ✓
 * 4. Set this constant to true ✓
 *
 * The type is `boolean`, not the literal `false`, so the composer's guards
 * stay live code for the type checker while the switch is off.
 */
export const IMAGE_ATTACHMENTS_ENABLED: boolean = true;

/** Image types the models accept. Anything else is refused at intake. */
export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** `accept` attribute for the file picker. Same list as the intake check. */
export const IMAGE_ACCEPT_ATTRIBUTE = SUPPORTED_IMAGE_TYPES.join(",");

/** Images allowed on one message. */
export const MAX_IMAGES = 20;

/** Largest single image, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Largest total for all images on one message, in bytes. The request ships
 * each image as a `data:` URL, and base64 makes the body about a third
 * larger than the files.
 */
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

/** The file fields the intake check reads. `File` satisfies it. */
export interface FileMeta {
  name: string;
  type: string;
  size: number;
}

/** One image held in the composer, ready to preview and to send. */
export interface ComposerImage {
  /** React key and removal handle. Not sent. */
  id: string;
  name: string;
  mimeType: string;
  /** Size of the source file. Drives the total-size limit and the label. */
  bytes: number;
  /** `data:` URL — both the thumbnail source and the wire payload. */
  dataUrl: string;
}

// Export the wire type for re-export convenience
export type { PromptImageAttachment } from "@valet/api/wire";

/** Human size for limits and labels: "4.2 MB", "820 KB", "512 bytes".
 * The shared formatter, under this file's established local name. */
export { formatSize };

/**
 * Split incoming files into the ones the composer keeps and a message for
 * each one it refuses. Each message names the limit and the action that
 * fixes it.
 *
 * The count and total budgets accumulate over `current`, so a batch that
 * crosses a limit part-way keeps the files before the crossing and refuses
 * the rest by name.
 */
export function acceptImages<T extends FileMeta>(
  current: readonly ComposerImage[],
  incoming: readonly T[],
): { accepted: T[]; rejected: string[] } {
  const accepted: T[] = [];
  const rejected: string[] = [];
  let count = current.length;
  let total = current.reduce((sum, image) => sum + image.bytes, 0);

  for (const file of incoming) {
    if (!isSupportedImageType(file.type)) {
      rejected.push(
        `${file.name} is not a supported image. Attach a PNG, JPEG, GIF, or WebP image.`,
      );
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      rejected.push(
        `${file.name} is ${formatSize(file.size)}. The limit is ${formatSize(MAX_IMAGE_BYTES)} for one image. ` +
          `Resize the image, then attach it again.`,
      );
      continue;
    }
    if (count >= MAX_IMAGES) {
      rejected.push(
        `${file.name} was not attached. The limit is ${MAX_IMAGES} images for one message. ` +
          `Remove an image, then attach it again.`,
      );
      continue;
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      rejected.push(
        `${file.name} was not attached. The limit is ${formatSize(MAX_TOTAL_BYTES)} for all images ` +
          `on one message. Remove an image, then attach it again.`,
      );
      continue;
    }
    accepted.push(file);
    count += 1;
    total += file.size;
  }

  return { accepted, rejected };
}

/** True when the composer's image path handles this MIME type. Anything
 * else routes to the file-upload path when file uploads are enabled. */
export function isSupportedImageType(type: string): boolean {
  return SUPPORTED_IMAGE_TYPES.some((supported) => supported === type);
}

/** Payload builder for the send request. */
export function toPromptAttachments(images: readonly ComposerImage[]): PromptImageAttachment[] {
  return images.map((image) => ({
    kind: "image",
    url: image.dataUrl,
    mimeType: image.mimeType,
    name: image.name,
  }));
}

/**
 * Read one file into a `ComposerImage`. Rejects with a user-facing message
 * — the caller shows it beside the composer.
 */
export function readImage(file: File): Promise<ComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(readFailure(file.name)));
        return;
      }
      resolve({
        id: newImageId(),
        name: file.name,
        mimeType: file.type,
        bytes: file.size,
        dataUrl: reader.result,
      });
    };
    reader.onerror = () => reject(new Error(readFailure(file.name)));
    reader.readAsDataURL(file);
  });
}

/** Message for a file the browser could not read. */
export function readFailure(name: string): string {
  return `${name} could not be read. Attach the file again.`;
}

/**
 * Files from a `FileList` (drop or picker). Nothing is filtered here on
 * purpose: `acceptImages` judges every file, so a wrong file always earns a
 * message instead of vanishing.
 */
export function filesFromList(list: ArrayLike<File> | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list);
}

/** The `DataTransferItem` fields the clipboard reader uses. */
export interface ClipboardFileItem {
  kind: string;
  getAsFile: () => File | null;
}

/**
 * Files from a paste. Items of kind "string" are skipped — a text paste
 * must stay a text paste.
 */
export function filesFromClipboard(
  items: ArrayLike<ClipboardFileItem> | null | undefined,
): File[] {
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/**
 * True when a drag carries files. Dragged text and links report other
 * types, and the composer must not claim those drops.
 */
export function transferHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types).includes("Files");
}

/** Local id for a held image. Same idiom as the optimistic message ids. */
function newImageId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
