import { useState, useCallback, useRef, useEffect, memo } from 'react';
import { useShiki } from './use-shiki';

interface CodeBlockProps {
  language: string;
  children: string;
}

export const CodeBlock = memo(function CodeBlock({ language, children }: CodeBlockProps) {
  const { ready, highlightCode } = useShiki();
  const [html, setHtml] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCodeRef = useRef<string>('');

  useEffect(() => {
    if (!ready) return;

    // Debounce during streaming — if content changes rapidly, wait 150ms
    const changed = children !== prevCodeRef.current;
    prevCodeRef.current = children;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (changed && html !== null) {
      // Already have a previous render — debounce updates
      debounceRef.current = setTimeout(() => {
        setHtml(highlightCode(children, language));
      }, 150);
    } else {
      // First render — highlight immediately
      setHtml(highlightCode(children, language));
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [ready, children, language, highlightCode, html]);

  return (
    <div className="group/code overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center justify-between bg-neutral-100 px-3 py-1 dark:bg-neutral-800">
        <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {language || 'text'}
        </span>
        <CopyButton text={children} />
      </div>
      {html ? (
        <div
          className="shiki-wrapper p-3 text-neutral-800 dark:text-neutral-200 [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!whitespace-pre-wrap [&_pre]:!break-words [&_code]:font-mono [&_code]:text-[12px] [&_code]:leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="whitespace-pre-wrap break-words p-3">
          <code className="font-mono text-[12px] leading-relaxed text-neutral-800 dark:text-neutral-200">
            {children}
          </code>
        </pre>
      )}
    </div>
  );
});

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may not be available
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 opacity-100 transition-opacity hover:text-neutral-700 md:opacity-0 md:group-hover/code:opacity-100 dark:text-neutral-400 dark:hover:text-neutral-200"
    >
      {copied ? (
        <>
          <CheckIcon className="h-3 w-3" />
          Copied
        </>
      ) : (
        <>
          <ClipboardIcon className="h-3 w-3" />
          Copy
        </>
      )}
    </button>
  );
}

function ClipboardIcon({ className }: { className?: string }) {
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
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
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
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
