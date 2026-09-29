import { X } from "lucide-react";
import { formatSize, type ComposerImage } from "./composer-images";

/**
 * Thumbnails for the images held in the composer, each with its own remove
 * control. Renders nothing while no image is held, so the composer keeps
 * its height until a picture arrives.
 */
export function ComposerImageStrip({
  images,
  onRemove,
}: {
  images: readonly ComposerImage[];
  onRemove: (id: string) => void;
}) {
  if (images.length === 0) return null;
  return (
    <ul aria-label="Attached images" className="mb-2 flex flex-wrap gap-2 px-3 pt-2">
      {images.map((image) => (
        <li key={image.id} className="relative">
          {/* The alt text is the file name: a screen reader user picks the
              right Remove button by the same name it reads here. */}
          <img
            src={image.dataUrl}
            alt={image.name}
            title={`${image.name} — ${formatSize(image.bytes)}`}
            className="h-16 w-16 rounded border border-[--border] object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(image.id)}
            aria-label={`Remove ${image.name}`}
            title={`Remove ${image.name}`}
            className="absolute -right-1.5 -top-1.5 rounded-full border border-[--border] bg-[--bg] p-0.5 text-muted hover:text-neutral-900 dark:hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
          >
            <X className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Why a file did not attach. One line per refused file, each naming the
 * limit and the action that fixes it. The list stays until the user
 * dismisses it or the next intake replaces it.
 */
export function ComposerImageErrors({
  messages,
  onDismiss,
}: {
  messages: readonly string[];
  onDismiss: () => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div
      role="alert"
      className="mb-2 flex items-start gap-2 rounded border border-danger-600/40 bg-danger-600/5 p-2 text-xs text-danger-600 dark:text-danger-500"
    >
      <ul className="flex-1 space-y-1">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss image errors"
        className="rounded p-0.5 hover:bg-danger-600/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-500"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
