import { lazy, Suspense, useEffect, useState } from 'react';

const MarkdownContentLazy = lazy(() =>
  import('./markdown-content').then((m) => ({ default: m.MarkdownContent }))
);

interface DeferredMarkdownContentProps {
  content: string;
  isStreaming?: boolean;
}

function PlainMarkdownFallback({ content }: { content: string }) {
  return (
    <div className="mt-1 max-w-full overflow-hidden whitespace-pre-wrap break-words text-[13px] leading-relaxed text-inherit">
      {content}
    </div>
  );
}

export function DeferredMarkdownContent({ content, isStreaming = false }: DeferredMarkdownContentProps) {
  const [shouldEnhance, setShouldEnhance] = useState(false);

  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(() => setShouldEnhance(true), { timeout: 1200 });
      return () => win.cancelIdleCallback?.(id);
    }

    const timeoutId = window.setTimeout(() => setShouldEnhance(true), 300);
    return () => window.clearTimeout(timeoutId);
  }, []);

  if (!shouldEnhance) {
    return <PlainMarkdownFallback content={content} />;
  }

  return (
    <Suspense fallback={<PlainMarkdownFallback content={content} />}>
      <MarkdownContentLazy content={content} isStreaming={isStreaming} />
    </Suspense>
  );
}
