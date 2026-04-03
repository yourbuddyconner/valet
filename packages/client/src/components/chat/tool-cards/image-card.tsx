import { useState } from 'react';
import { ToolCardShell } from './tool-card-shell';
import type { ToolCallData } from './types';

export function ImageCard({ tool }: { tool: ToolCallData }) {
  const [expanded, setExpanded] = useState(false);

  const args = (tool.args ?? {}) as Record<string, unknown>;
  const result = tool.result as Record<string, unknown> | string | null;

  // Extract caption/description from args
  const caption =
    (typeof args.description === 'string' && args.description) ||
    (typeof args.caption === 'string' && args.caption) ||
    (typeof args.alt === 'string' && args.alt) ||
    (typeof args.title === 'string' && args.title) ||
    null;

  // Extract image data from result - handle various formats
  const imageData = extractImageData(result);

  return (
    <ToolCardShell
      icon={<ImageIcon className="h-3.5 w-3.5" />}
      label={tool.toolName}
      status={tool.status}
      summary={caption ? (
        <span className="text-neutral-500 dark:text-neutral-400">{caption}</span>
      ) : undefined}
    >
      {imageData && (
        <div className="p-2">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="block w-full text-left focus:outline-none focus:ring-2 focus:ring-accent/50 rounded-md"
          >
            <img
              src={imageData}
              alt={caption || 'Screenshot'}
              loading="lazy"
              className={`rounded-md border border-neutral-200 dark:border-neutral-700 object-contain transition-all ${
                expanded ? 'max-h-[600px]' : 'max-h-[200px]'
              }`}
              style={{ width: '100%' }}
            />
          </button>
          {!expanded && (
            <p className="mt-1 text-center text-[10px] text-neutral-400 dark:text-neutral-500">
              Click to expand
            </p>
          )}
        </div>
      )}
      {!imageData && tool.status === 'completed' && (
        <div className="p-3 text-xs text-neutral-500 dark:text-neutral-400">
          No image data found in result
        </div>
      )}
    </ToolCardShell>
  );
}

/** Extract base64 image data URI from various result formats */
function extractImageData(result: unknown): string | null {
  if (!result) return null;

  if (typeof result === 'string') {
    if (result.startsWith('data:image/')) {
      return result;
    }
    if (result.startsWith('http://') || result.startsWith('https://')) {
      return result;
    }
    // Result is raw base64 - assume PNG
    if (isBase64(result)) {
      return `data:image/png;base64,${result}`;
    }
  }

  // Result is an object with image data
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;

    // Common field names for image data
    for (const key of ['image', 'data', 'base64', 'screenshot', 'content', 'imageData', 'src']) {
      const val = r[key];
      if (typeof val === 'string') {
        if (val.startsWith('data:image/')) {
          return val;
        }
        if (isBase64(val)) {
          const mimeType = (typeof r.mimeType === 'string' ? r.mimeType : null) ||
                          (typeof r.mime === 'string' ? r.mime : null) ||
                          (typeof r.type === 'string' && r.type.startsWith('image/') ? r.type : null) ||
                          'image/png';
          return `data:${mimeType};base64,${val}`;
        }
        // Could be a URL
        if (val.startsWith('http://') || val.startsWith('https://')) {
          return val;
        }
      }
    }
  }

  return null;
}

/** Basic check if string looks like base64 data */
function isBase64(str: string): boolean {
  if (!str || str.length < 100) return false; // Images are usually longer
  // Check for base64 characters only (with optional padding)
  return /^[A-Za-z0-9+/]+=*$/.test(str.slice(0, 100));
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}
