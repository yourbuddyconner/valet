interface DisplaySessionStatusInput {
  sessionStatus: string;
  connectionStatus: string;
  agentStatus: string;
  runnerConnected: boolean;
}

export function getDisplaySessionStatus({
  sessionStatus,
  connectionStatus,
  agentStatus,
  runnerConnected,
}: DisplaySessionStatusInput): string {
  if (connectionStatus === 'connecting' && sessionStatus === 'initializing') {
    return 'connecting';
  }
  if (agentStatus === 'queued' && !runnerConnected && sessionStatus !== 'terminated' && sessionStatus !== 'archived') {
    return 'restoring';
  }
  return sessionStatus;
}
