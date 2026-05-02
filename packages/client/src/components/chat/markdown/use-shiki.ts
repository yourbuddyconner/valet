import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { HighlighterCore } from 'shiki';

let highlighterPromise: Promise<HighlighterCore> | null = null;
let highlighterInstance: HighlighterCore | null = null;

const PRELOAD_LANGS = [
  'typescript',
  'javascript',
  'python',
  'bash',
  'json',
  'html',
  'css',
  'tsx',
  'jsx',
  'sql',
  'yaml',
  'markdown',
  'rust',
  'go',
] as const;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(async ({ createHighlighter }) => {
      const hl = await createHighlighter({
        themes: ['github-light', 'github-dark'],
        langs: [...PRELOAD_LANGS],
      });
      highlighterInstance = hl;
      return hl;
    });
  }
  return highlighterPromise;
}

/** Subscribe to .dark class changes on <html> so highlights re-render on theme switch. */
function subscribeToDarkMode(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

function getIsDark() {
  return document.documentElement.classList.contains('dark');
}

function getServerIsDark() {
  return false;
}

export function useShiki() {
  const [ready, setReady] = useState(highlighterInstance !== null);
  const isDark = useSyncExternalStore(subscribeToDarkMode, getIsDark, getServerIsDark);

  useEffect(() => {
    if (!ready) {
      getHighlighter().then(() => setReady(true));
    }
  }, [ready]);

  const highlightCode = useCallback(
    (code: string, lang: string): string | null => {
      if (!highlighterInstance) return null;

      // Plaintext has nothing to highlight — use the fallback renderer.
      if (!lang || lang === 'text' || lang === 'plaintext' || lang === 'txt') {
        return null;
      }

      try {
        return highlighterInstance.codeToHtml(code, {
          lang,
          theme: isDark ? 'github-dark' : 'github-light',
        });
      } catch {
        // Language not loaded — fall back
        return null;
      }
    },
    [isDark]
  );

  return { ready, highlightCode };
}
