import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/cn";

/**
 * Markdown rendering for chat message text. Wraps `react-markdown` + GFM
 * (tables, strikethrough, task lists, autolinks) with our token-aware
 * styling. Code blocks/pre/inline-code/links are themed against `--bg`,
 * `--fg`, accent — not raw color values, so light/dark Just Works.
 *
 * No raw HTML is allowed (react-markdown's default), so this is safe to
 * render arbitrary assistant or user text.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        // Base prose styles + dark mode invert. `max-w-none` so chat text
        // can use the full message column.
        "prose prose-sm prose-neutral dark:prose-invert max-w-none",
        // First/last whitespace tidy.
        "prose-p:leading-relaxed prose-p:my-2 first:prose-p:mt-0 last:prose-p:mb-0",
        // Headings — small bumps; chat shouldn't have giant h1s.
        "prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-h1:text-base prose-h2:text-base prose-h3:text-sm",
        // Inline code — pill style, no surrounding backticks.
        "prose-code:bg-neutral-100 dark:prose-code:bg-neutral-800",
        "prose-code:rounded prose-code:px-1 prose-code:py-0.5",
        "prose-code:text-[0.85em] prose-code:font-normal",
        "prose-code:before:content-none prose-code:after:content-none",
        // Code blocks — outlined card; horizontal scroll for long lines.
        "prose-pre:bg-neutral-100 dark:prose-pre:bg-neutral-900",
        "prose-pre:border prose-pre:border-[--border]",
        "prose-pre:rounded-md prose-pre:px-3 prose-pre:py-2",
        "prose-pre:text-xs prose-pre:my-2",
        // Links — accent color; underline only on hover. Open in new tab.
        "prose-a:text-accent-600 dark:prose-a:text-accent-100",
        "prose-a:no-underline hover:prose-a:underline",
        // Lists — tighter than prose default for chat density.
        "prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5",
        // Tables — borderless prose default looks bad; border + zebra.
        "prose-table:my-2 prose-th:font-semibold",
        "prose-td:border-t prose-td:border-[--border] prose-td:py-1",
        // Blockquote — accent left bar.
        "prose-blockquote:border-l-2 prose-blockquote:border-neutral-300",
        "dark:prose-blockquote:border-neutral-700",
        "prose-blockquote:not-italic prose-blockquote:font-normal",
        "prose-blockquote:text-[--muted] prose-blockquote:my-2",
        // hr — subtle separator.
        "prose-hr:border-[--border] prose-hr:my-3",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Force external links to open in a new tab and not leak referrer.
          a: ({ children, href, ...rest }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
