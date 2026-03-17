import { useRef, useEffect } from 'react';
import { useOrchestratorInfo, useCreateOrchestrator } from '@/api/orchestrator';

/**
 * Automatically restarts the orchestrator when it enters a terminal state.
 * Returns status info so the UI can show passive indicators.
 *
 * Uses a ref to prevent retry loops — only attempts once per needsRestart
 * detection cycle, resets when the flag clears (successful restart).
 */
export function useAutoRestartOrchestrator(enabled = true) {
  const { data: orchInfo } = useOrchestratorInfo();
  const createOrchestrator = useCreateOrchestrator();
  const attemptedRef = useRef(false);

  const needsRestart = enabled && (orchInfo?.needsRestart ?? false);
  const identity = orchInfo?.identity;

  // Reset the attempt flag when needsRestart clears (restart succeeded)
  useEffect(() => {
    if (!needsRestart) {
      attemptedRef.current = false;
    }
  }, [needsRestart]);

  // Auto-trigger restart once when needsRestart is detected
  useEffect(() => {
    if (needsRestart && identity && !attemptedRef.current && !createOrchestrator.isPending) {
      attemptedRef.current = true;
      createOrchestrator.mutate({
        name: identity.name,
        handle: identity.handle,
        customInstructions: identity.customInstructions ?? undefined,
      });
    }
  }, [needsRestart, identity, createOrchestrator.isPending]);

  return {
    needsRestart,
    isRestarting: createOrchestrator.isPending,
    restartFailed: attemptedRef.current && createOrchestrator.isError,
    error: createOrchestrator.error,
    retry: () => {
      if (!identity) return;
      attemptedRef.current = true;
      createOrchestrator.mutate({
        name: identity.name,
        handle: identity.handle,
        customInstructions: identity.customInstructions ?? undefined,
      });
    },
  };
}
