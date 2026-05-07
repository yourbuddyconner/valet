import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getChannelForMessage, dropEmission } from './channel-resolver.js';
import type { PromptQueue } from './prompt-queue.js';

function makePromptQueueMock(
  row: { channelType: string | null; channelId: string | null } | undefined,
): { queue: PromptQueue; getChannelTargetById: ReturnType<typeof vi.fn> } {
  const getChannelTargetById = vi.fn().mockReturnValue(row);
  const queue = { getChannelTargetById } as unknown as PromptQueue;
  return { queue, getChannelTargetById };
}

function makePromptQueueMockFromMap(
  rowsByMessageId: Record<string, { channelType: string | null; channelId: string | null } | undefined>,
): PromptQueue {
  const getChannelTargetById = vi.fn((messageId: string) => rowsByMessageId[messageId]);
  return { getChannelTargetById } as unknown as PromptQueue;
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

  it('calls getChannelTargetById with the exact messageId passed in', () => {
    const { queue, getChannelTargetById } = makePromptQueueMock({
      channelType: 'telegram',
      channelId: 'T999',
    });

    getChannelForMessage(queue, 'exact-message-id');

    expect(getChannelTargetById).toHaveBeenCalledTimes(1);
    expect(getChannelTargetById).toHaveBeenCalledWith('exact-message-id');
  });

  it('uses reply_channel_* precedence (caller mock returns the precedence-applied row)', () => {
    const promptQueue = makePromptQueueMockFromMap({
      'msg-1': { channelType: 'slack-thread-reply-target', channelId: 'C-thread-id' },
    });
    const result = getChannelForMessage(promptQueue, 'msg-1');
    expect(result).toEqual({ channelType: 'slack-thread-reply-target', channelId: 'C-thread-id' });
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
