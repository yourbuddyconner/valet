import { useTerminateSession } from '@/api/sessions';
import { useOrchestratorInfo, useCreateOrchestrator } from '@/api/orchestrator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface RefreshOrchestratorDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RefreshOrchestratorDialog({
  sessionId,
  open,
  onOpenChange,
}: RefreshOrchestratorDialogProps) {
  const terminateSession = useTerminateSession();
  const createOrchestrator = useCreateOrchestrator();
  const { data: orchInfo } = useOrchestratorInfo();

  const isPending = terminateSession.isPending || createOrchestrator.isPending;

  const handleRefresh = async () => {
    if (!orchInfo?.identity) return;

    try {
      // Terminate the current session
      await terminateSession.mutateAsync(sessionId);

      // Re-create with the same identity
      await createOrchestrator.mutateAsync({
        name: orchInfo.identity.name,
        handle: orchInfo.identity.handle,
        customInstructions: orchInfo.identity.customInstructions ?? undefined,
      });

      // Navigate to the new session (full reload to clear stale WS connections & chat state)
      window.location.href = '/sessions/orchestrator';
    } catch {
      // Errors are handled by the mutations
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Refresh Orchestrator</AlertDialogTitle>
          <AlertDialogDescription>
            This will restart {orchInfo?.identity?.name ?? 'your orchestrator'} with a fresh sandbox.
            Your identity and memories will be preserved, but the current
            session history will be cleared.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRefresh}
            disabled={isPending}
          >
            {terminateSession.isPending
              ? 'Stopping...'
              : createOrchestrator.isPending
                ? 'Restarting...'
                : 'Refresh'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
