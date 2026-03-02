import { memo, useEffect, useRef, useState, useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import mermaid from 'mermaid';

let mermaidInitialized = false;
let idCounter = 0;

function ensureMermaidInit(isDark: boolean) {
  const theme = isDark ? 'dark' : 'default';
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: 'strict',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    });
    mermaidInitialized = true;
  }
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.15;

interface MermaidBlockProps {
  children: string;
}

export const MermaidBlock = memo(function MermaidBlock({ children }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${idCounter++}`);

  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const [showSource, setShowSource] = useState(false);
  const toggleSource = useCallback(() => setShowSource((s) => !s), []);

  // Pan & zoom state
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });

  const resetView = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setScale((s) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s + delta)));
  }, []);

  // Attach wheel listener with { passive: false } so we can preventDefault
  useEffect(() => {
    const el = containerRef.current;
    if (!el || showSource) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel, showSource, svg]);

  const handlePointerDown = useCallback((e: ReactPointerEvent) => {
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    translateStart.current = { ...translate };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [translate]);

  const handlePointerMove = useCallback((e: ReactPointerEvent) => {
    if (!dragging.current) return;
    setTranslate({
      x: translateStart.current.x + (e.clientX - dragStart.current.x),
      y: translateStart.current.y + (e.clientY - dragStart.current.y),
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        ensureMermaidInit(isDark);
        const { svg: rendered } = await mermaid.render(idRef.current, children.trim());
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
          setSvg(null);
        }
        // Clean up any leftover error container mermaid may have injected
        const errorEl = document.getElementById(`d${idRef.current}`);
        errorEl?.remove();
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [children, isDark]);

  // Reset view when content changes
  useEffect(() => {
    resetView();
  }, [children, resetView]);

  const isTransformed = scale !== 1 || translate.x !== 0 || translate.y !== 0;
  const zoomPercent = Math.round(scale * 100);

  if (error) {
    return (
      <div className="overflow-hidden rounded-md border border-red-200 dark:border-red-800">
        <div className="flex items-center justify-between bg-red-50 px-3 py-1 dark:bg-red-900/30">
          <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-red-500">
            mermaid (error)
          </span>
        </div>
        <pre className="overflow-x-auto p-3">
          <code className="font-mono text-[12px] leading-relaxed text-neutral-800 dark:text-neutral-200">
            {children}
          </code>
        </pre>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center justify-between bg-neutral-100 px-3 py-1 dark:bg-neutral-800">
        <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          mermaid
        </span>
        <div className="flex items-center gap-1.5">
          {svg && !showSource && (
            <>
              <span className="font-mono text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                {zoomPercent}%
              </span>
              {isTransformed && (
                <button
                  type="button"
                  onClick={resetView}
                  className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                >
                  Reset
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={toggleSource}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            {showSource ? 'Diagram' : 'Source'}
          </button>
        </div>
      </div>
      {showSource ? (
        <pre className="overflow-x-auto p-3">
          <code className="font-mono text-[12px] leading-relaxed text-neutral-800 dark:text-neutral-200">
            {children}
          </code>
        </pre>
      ) : svg ? (
        <div
          ref={containerRef}
          className="relative overflow-hidden bg-white dark:bg-neutral-900"
          style={{ cursor: dragging.current ? 'grabbing' : 'grab', minHeight: 120 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            className="flex justify-center p-4 [&_svg]:max-w-none"
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: 'center center',
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center p-6 text-[12px] text-neutral-400">
          Rendering diagram...
        </div>
      )}
    </div>
  );
});
