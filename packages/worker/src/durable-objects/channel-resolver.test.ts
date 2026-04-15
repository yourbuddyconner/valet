import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getChannelForMessage, dropEmission } from './channel-resolver.js';
import type { PromptQueue } from './prompt-queue.js';

function makePromptQueueMock(
  row: { channelType: string | null; channelId: string | null } | undefined,
): { queue: PromptQueue; getRowById: ReturnType<typeof vi.fn> } {
  const getRowById = vi.fn().mockReturnValue(row);
  const queue = { getRowById } as unknown as PromptQueue;
  return { queue, getRowById };
}

describe('getChannelForMessage', () => {
  it('returns the channel from the prompt_queue row when both fields present', () => {
    const { queue } = makePromptQueueMock({
      channelType: 'slack',
      channelId: 'C123',
    });

    const result = getChannelForMessage(queue, 'msg-1');

    expect(result).toEqual({ channelType: 'slack', channelId: 'C123' });
  });

  it('returns null when the row is missing', () => {
    const { queue } = makePromptQueueMock(undefined);

    const result = getChannelForMessage(queue, 'msg-missing');

    expect(result).toBeNull();
  });

  it('returns null when row is present but channelType is missing', () => {
    const { queue } = makePromptQueueMock({
      channelType: null,
      channelId: 'C123',
    });

    const result = getChannelForMessage(queue, 'msg-no-type');

    expect(result).toBeNull();
  });

  it('returns null when row is present but channelId is missing', () => {
    const { queue } = makePromptQueueMock({
      channelType: 'slack',
      channelId: null,
    });

    const result = getChannelForMessage(queue, 'msg-no-id');

    expect(result).toBeNull();
  });

  it('calls getRowById with the exact messageId passed in', () => {
    const { queue, getRowById } = makePromptQueueMock({
      channelType: 'telegram',
      channelId: 'T999',
    });

    getChannelForMessage(queue, 'exact-message-id');

    expect(getRowById).toHaveBeenCalledTimes(1);
    expect(getRowById).toHaveBeenCalledWith('exact-message-id');
  });
});

describe('dropEmission', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('logs a warning matching /dropped emission/ with the reason and context fields', () => {
    dropEmission('no_prompt_row', { messageId: 'abc', sessionId: 'sess-1' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, payload] = warnSpy.mock.calls[0];
    expect(message).toMatch(/dropped emission/);
    expect(payload).toMatchObject({
      reason: 'no_prompt_row',
      messageId: 'abc',
      sessionId: 'sess-1',
    });
  });
});
