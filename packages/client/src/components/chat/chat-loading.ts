interface ChatLoadingState {
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  historyReady: boolean;
  messageCount: number;
}

export function shouldShowChatSkeleton({
  connectionStatus,
  historyReady,
  messageCount,
}: ChatLoadingState): boolean {
  if (historyReady || messageCount > 0) return false;
  return connectionStatus === 'connecting';
}
