import { describe, expect, it } from 'vitest';
import { shouldShowChatSkeleton } from './chat-loading';

describe('shouldShowChatSkeleton', () => {
  it('shows skeleton only while connecting before history is ready', () => {
    expect(
      shouldShowChatSkeleton({
        connectionStatus: 'connecting',
        historyReady: false,
        messageCount: 0,
      })
    ).toBe(true);
  });

  it('renders chat once history is ready even if the socket is still connecting', () => {
    expect(
      shouldShowChatSkeleton({
        connectionStatus: 'connecting',
        historyReady: true,
        messageCount: 0,
      })
    ).toBe(false);
  });

  it('renders chat when messages already exist even if readiness bookkeeping lags', () => {
    expect(
      shouldShowChatSkeleton({
        connectionStatus: 'connecting',
        historyReady: false,
        messageCount: 3,
      })
    ).toBe(false);
  });
});
