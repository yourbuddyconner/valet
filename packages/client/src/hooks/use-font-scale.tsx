import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import {
  FONT_SCALE_DEFAULT,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
} from '@/lib/font-scale';

function applyFontScale(scale: number) {
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale));
  document.documentElement.style.fontSize = `${clamped * 100}%`;
}

export function useFontScale() {
  const fontScale = useUIStore((s) => s.fontScale);
  const setFontScale = useUIStore((s) => s.setFontScale);
  return {
    fontScale,
    setFontScale,
    resetFontScale: () => setFontScale(FONT_SCALE_DEFAULT),
  };
}

/**
 * Owns the single DOM write for the user-controlled font scale. Reads the
 * value from the persisted UI store and pushes it onto <html>'s font-size so
 * every rem-based size in the app scales accordingly. PostCSS rewrites the
 * codebase's pixel font sizes into rems at build time (see postcss.config.js),
 * which is what makes the scale propagate end-to-end.
 *
 * Layout-effect (not effect) so the size is applied before the first paint,
 * eliminating the brief flash at the default scale on reload.
 */
export function FontScaleProvider({ children }: { children: React.ReactNode }) {
  const fontScale = useUIStore((s) => s.fontScale);

  React.useLayoutEffect(() => {
    applyFontScale(fontScale);
  }, [fontScale]);

  return <>{children}</>;
}
