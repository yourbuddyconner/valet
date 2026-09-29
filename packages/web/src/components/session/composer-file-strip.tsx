import { FileChip } from "./composer-file-chip";
import type { ComposerFile } from "./composer-files";

interface FileStripProps {
  files: ComposerFile[];
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
}

/**
 * Flex-wrap row of file chips, one per file in the composer.
 * Mirrors ComposerImageStrip's layout.
 */
export function ComposerFileStrip({ files, onRemove, onRetry }: FileStripProps) {
  if (files.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-2 px-3 pt-2" aria-label="Attached files">
      {files.map((file) => (
        <FileChip key={file.id} file={file} onRemove={onRemove} onRetry={onRetry} />
      ))}
    </div>
  );
}

/**
 * Display errors that occurred during file intake (count limits, etc.)
 * Mirrors ComposerImageErrors.
 */
export interface FileErrorsProps {
  messages: string[];
  onDismiss: () => void;
}

export function ComposerFileErrors({ messages, onDismiss }: FileErrorsProps) {
  if (messages.length === 0) return null;

  return (
    // role="alert" for parity with ComposerImageErrors — screen readers
    // must announce file errors the same way they announce image errors.
    <div role="alert" className="mb-2 p-2 bg-danger-50 dark:bg-danger-900/20 rounded text-sm text-danger-600">
      <div className="flex justify-between items-start gap-2">
        <div>
          {messages.map((msg, i) => (
            <div key={i}>{msg}</div>
          ))}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-danger-600 hover:text-danger-700 font-bold"
          aria-label="Dismiss errors"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
