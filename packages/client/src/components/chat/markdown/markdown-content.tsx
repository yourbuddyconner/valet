import { memo, useMemo, createContext, useContext, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkGemoji from 'remark-gemoji';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import { CodeBlock } from './code-block';
import { MermaidBlock } from './mermaid-block';
import { MarkdownImage } from './markdown-image';

const StreamingContext = createContext(false);

// Extend default sanitize schema to allow data: URIs on img src (for base64 screenshots)
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), ['src', /^data:image\//i, /^https?:\/\//i]],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'data'],
  },
};

const remarkPlugins = [remarkGfm, remarkGemoji];
const rehypePlugins = [[rehypeSanitize, sanitizeSchema]] as ComponentProps<typeof ReactMarkdown>['rehypePlugins'];

function MermaidOrPlaceholder({ code }: { code: string }) {
  const isStreaming = useContext(StreamingContext);
  if (isStreaming) {
    return (
      <div className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
        <div className="flex items-center gap-2 bg-neutral-100 px-3 py-1.5 dark:bg-neutral-800">
          <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            mermaid
          </span>
          <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
            Rendering when complete...
          </span>
        </div>
      </div>
    );
  }
  return <MermaidBlock>{code}</MermaidBlock>;
}

const components: Components = {
  // Route fenced code blocks through our CodeBlock component
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...rest }) {
    const match = /language-(\w+)/.exec(className || '');
    const code = String(children).replace(/\n$/, '');
    const isBlock = Boolean(match) || code.includes('\n');

    if (isBlock) {
      if (match?.[1] === 'mermaid') {
        return <MermaidOrPlaceholder code={code} />;
      }
      return <CodeBlock language={match?.[1] ?? 'text'}>{code}</CodeBlock>;
    }

    return (
      <code
        className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200"
        {...rest}
      >
        {children}
      </code>
    );
  },
  // Wrap GFM tables so wide tables scroll horizontally within the message
  // column instead of pushing the whole assistant turn past the viewport.
  table({ children, ...rest }) {
    return (
      <div className="max-w-full overflow-x-auto">
        <table {...rest}>{children}</table>
      </div>
    );
  },
  img({ src, alt }) {
    return <MarkdownImage src={src} alt={alt} />;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline underline-offset-2 hover:text-accent/80"
      >
        {children}
      </a>
    );
  },
};

interface MarkdownContentProps {
  content: string;
  isStreaming?: boolean;
}

/**
 * Intercept native copy to strip inline colors and backgrounds (Shiki spans,
 * dark-mode grays, Tailwind computed styles) so pasting into Gmail/Docs
 * produces clean black-on-white text while preserving structural formatting
 * (bold, lists, links, code blocks).
 */
function handleCopy(e: React.ClipboardEvent<HTMLDivElement>) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const range = selection.getRangeAt(0);
  const fragment = range.cloneContents();
  const wrapper = document.createElement('div');
  wrapper.appendChild(fragment);

  // Strip color/background from ALL elements — covers both explicit inline
  // styles (Shiki spans) and browser-serialized computed styles (Tailwind bg-*).
  wrapper.querySelectorAll('*').forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.removeProperty('color');
    htmlEl.style.removeProperty('background-color');
    htmlEl.style.removeProperty('background');
    // Clean up empty style attributes
    if (htmlEl.hasAttribute('style') && !htmlEl.style.cssText.trim()) {
      htmlEl.removeAttribute('style');
    }
    // Strip class attributes — they carry no meaning outside our app
    // and some email clients may resolve them unexpectedly
    htmlEl.removeAttribute('class');
  });

  // Force clean defaults at the root
  wrapper.style.color = '#000000';
  wrapper.style.background = 'transparent';

  e.clipboardData.setData('text/html', wrapper.outerHTML);
  e.clipboardData.setData('text/plain', selection.toString());
  e.preventDefault();
}

export const MarkdownContent = memo(function MarkdownContent({ content, isStreaming = false }: MarkdownContentProps) {
  // Memoize to avoid recreating the markdown tree on parent re-renders
  const element = useMemo(
    () => (
      <StreamingContext.Provider value={isStreaming}>
        <div
          className="markdown-body mt-1 max-w-full overflow-hidden text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-300"
          onCopy={handleCopy}
        >
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={components}
          >
            {content}
          </ReactMarkdown>
        </div>
      </StreamingContext.Provider>
    ),
    [content, isStreaming]
  );

  return element;
});
