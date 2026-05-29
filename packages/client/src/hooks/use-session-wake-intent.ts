import { useEffect, useCallback, useRef } from 'react';
import { useWakeSession } from '@/api/sessions';
import { useVisibility } from '@/hooks/use-visibility';

/**
 * Encapsulates the "if hibernated, wake" guard for session intent signals.
 *
 * Returns a `signalIntent` callback that can be called from any interaction
 * point (panel toggles, new thread, etc.) to wake a hibernated session.
 *
 * Also automatically wakes the session when:
 * - The session data first resolves as hibernated (page navigation)
 * - The page becomes visible again after being hidden
 */
export function useSessionWakeIntent(
  sessionId: string | undefined,
  sessionStatus: string | undefined,
) {
  const wakeMutation = useWakeSession();

  // Track previous visibility so we only fire on hidden→visible transitions
  const wasHidden = useRef(false);
  const isVisible = useVisibility();

  const shouldWake =
    !!sessionId && sessionStatus === 'hibernated' && !wakeMutation.isPending;

  const signalIntent = useCallback(() => {
    if (shouldWake) {
      wakeMutation.mutate(sessionId);
    }
  }, [shouldWake, wakeMutation, sessionId]);

  // Wake on initial load — fires once per session when session data first
  // arrives showing 'hibernated'. Reset when navigating to a different session.
  const hasFiredMount = useRef(false);
  useEffect(() => {
    hasFiredMount.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (shouldWake && !hasFiredMount.current) {
      hasFiredMount.current = true;
      wakeMutation.mutate(sessionId);
    }
  }, [shouldWake, wakeMutation, sessionId]);

  // Wake on page visibility return (tab switch back)
  useEffect(() => {
    if (!isVisible) {
      wasHidden.current = true;
      return;
    }
    if (wasHidden.current && shouldWake) {
      wakeMutation.mutate(sessionId);
    }
    wasHidden.current = false;
  }, [isVisible, shouldWake, wakeMutation, sessionId]);

  return signalIntent;
}
