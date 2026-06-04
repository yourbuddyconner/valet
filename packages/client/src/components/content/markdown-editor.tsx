import * as React from 'react';
import { MarkdownContent } from '@/components/chat/markdown';
import { cn } from '@/lib/cn';
import { formatMarkdownSelection, type MarkdownFormat } from './markdown-editor-utils';

interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  required?: boolean;
  minHeightClassName?: string;
}

type ToolbarItem = { format: MarkdownFormat; label: string; icon: React.ReactNode };
type ToolbarGroup = ToolbarItem[];

const toolbarGroups: ToolbarGroup[] = [
  [
    { format: 'heading', label: 'Heading', icon: <span className="text-[11px] font-semibold">H2</span> },
  ],
  [
    { format: 'bulletList', label: 'Bulleted list', icon: <ListIcon ordered={false} /> },
    { format: 'numberedList', label: 'Numbered list', icon: <ListIcon ordered /> },
  ],
  [
    { format: 'codeBlock', label: 'Code block', icon: <CodeBlockIcon /> },
    { format: 'link', label: 'Link', icon: <LinkIcon /> },
    { format: 'inlineCode', label: 'Inline code', icon: <span className="font-mono text-sm">`</span> },
  ],
];

export function MarkdownEditor({
  value,
  onChange,
  placeholder = 'Write markdown...',
  readOnly = false,
  required = false,
  minHeightClassName = 'min-h-[28rem]',
}: MarkdownEditorProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const applyFormat = (format: MarkdownFormat) => {
    const textarea = textareaRef.current;
    if (!textarea || !onChange) return;

    const result = formatMarkdownSelection(
      value,
      textarea.selectionStart,
      textarea.selectionEnd,
      format,
    );
    onChange(result.value);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };

  if (readOnly) {
    return (
      <div className={cn('rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900/60', minHeightClassName)}>
        {value.trim() ? (
          <MarkdownContent content={value} />
        ) : (
          <p className="text-sm text-neutral-400">No content.</p>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-800/80">
        {toolbarGroups.map((group, groupIndex) => (
          <React.Fragment key={groupIndex}>
            {groupIndex > 0 && (
              <div className="mx-1 h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" aria-hidden="true" />
            )}
            {group.map((item) => (
              <button
                key={item.format}
                type="button"
                title={item.label}
                aria-label={item.label}
                onClick={() => applyFormat(item.format)}
                className="flex h-7 w-7 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 focus:outline-none focus:ring-2 focus:ring-accent/40 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
              >
                {item.icon}
              </button>
            ))}
          </React.Fragment>
        ))}
      </div>

      <div className="grid lg:grid-cols-2">
        <div className="border-b border-neutral-200 dark:border-neutral-700 lg:border-b-0 lg:border-r">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={placeholder}
            required={required}
            className={cn(
              'block w-full resize-none border-0 bg-white p-4 font-mono text-sm leading-6 text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500',
              minHeightClassName,
            )}
          />
        </div>
        <div className={cn('bg-neutral-50 p-4 dark:bg-neutral-950/40', minHeightClassName)}>
          {value.trim() ? (
            <MarkdownContent content={value} />
          ) : (
            <p className="text-sm text-neutral-400">{placeholder}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ListIcon({ ordered }: { ordered: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ordered ? (
        <>
          <path d="M10 6h11" />
          <path d="M10 12h11" />
          <path d="M10 18h11" />
          <path d="M4 6h1v4" />
          <path d="M4 10h2" />
          <path d="M4 14h2v4H4" />
        </>
      ) : (
        <>
          <path d="M8 6h13" />
          <path d="M8 12h13" />
          <path d="M8 18h13" />
          <path d="M3 6h.01" />
          <path d="M3 12h.01" />
          <path d="M3 18h.01" />
        </>
      )}
    </svg>
  );
}

function CodeBlockIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}
