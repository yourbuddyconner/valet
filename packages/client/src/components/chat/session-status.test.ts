import { describe, expect, it } from 'vitest';
import { getDisplaySessionStatus } from './session-status';

describe('getDisplaySessionStatus', () => {
  it('shows connecting while the initial websocket connection is still pending', () => {
    expect(getDisplaySessionStatus({
      sessionStatus: 'initializing',
      connectionStatus: 'connecting',
      agentStatus: 'idle',
      runnerConnected: false,
    })).toBe('connecting');
  });

  it('shows restoring when queued work is waiting on the runner', () => {
    expect(getDisplaySessionStatus({
      sessionStatus: 'running',
      connectionStatus: 'connected',
      agentStatus: 'queued',
      runnerConnected: false,
    })).toBe('restoring');
  });

  it('otherwise preserves the session lifecycle status', () => {
    expect(getDisplaySessionStatus({
      sessionStatus: 'running',
      connectionStatus: 'connected',
      agentStatus: 'idle',
      runnerConnected: true,
    })).toBe('running');
  });
});
