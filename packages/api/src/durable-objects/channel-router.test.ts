import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractivePrompt, InteractiveResolution } from '@valet/sdk';
import { ChannelRouter, type ChannelRouterDeps } from './channel-router.js';

function mockDeps(overrides?: Partial<ChannelRouterDeps>): ChannelRouterDeps {
  return {
    resolveToken: vi.fn().mockResolvedValue('mock-token'),
    resolvePersona: vi.fn().mockResolvedValue(undefined),
    onReplySent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const mockTransport = {
  channelType: 'slack',
  sendMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'ts123' }),
  sendInteractivePrompt: vi.fn().mockResolvedValue({ channelId: 'C123', messageId: 'msg1' }),
  updateInteractivePrompt: vi.fn().mockResolvedValue(undefined),
  parseTarget: vi.fn((channelId: string) => {
    if (channelId.includes(':')) {
      const idx = channelId.indexOf(':');
      return {
        channelType: 'slack',
        channelId: channelId.slice(0, idx),
        threadId: channelId.slice(idx + 1),
      };
    }
    return { channelType: 'slack', channelId };
  }),
};

vi.mock('../channels/registry.js', () => ({
  channelRegistry: {
    getTransport: vi.fn((type: string) => (type === 'slack' ? mockTransport : null)),
  },
}));

describe('ChannelRouter', () => {
  let router: ChannelRouter;
  let deps: ChannelRouterDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = mockDeps();
    router = new ChannelRouter(deps);
  });

  describe('sendReply', () => {
    it('resolves transport, token, persona and sends', async () => {
      const result = await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123:1234.5678',
        message: 'hello',
      });

      expect(result).toEqual({ success: true });
      expect(deps.resolveToken).toHaveBeenCalledWith('slack', 'u1');
      expect(deps.resolvePersona).toHaveBeenCalledWith('u1');
      expect(mockTransport.parseTarget).toHaveBeenCalledWith('C123:1234.5678');
      expect(mockTransport.sendMessage).toHaveBeenCalledWith(
        { channelType: 'slack', channelId: 'C123', threadId: '1234.5678' },
        { markdown: 'hello' },
        expect.objectContaining({ token: 'mock-token', userId: 'u1' }),
      );
    });

    it('calls onReplySent on success when followUp is not false', async () => {
      await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123',
        message: 'hi',
      });

      expect(deps.onReplySent).toHaveBeenCalledWith('slack', 'C123');
    });

    it('does not call onReplySent when followUp is false', async () => {
      await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123',
        message: 'hi',
        followUp: false,
      });

      expect(deps.onReplySent).not.toHaveBeenCalled();
    });

    it('returns error for unknown channel type', async () => {
      const result = await router.sendReply({
        userId: 'u1',
        channelType: 'unknown',
        channelId: 'X',
        message: 'hi',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported channel type');
    });

    it('returns error when no token available', async () => {
      deps = mockDeps({ resolveToken: vi.fn().mockResolvedValue(undefined) });
      router = new ChannelRouter(deps);

      const result = await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123',
        message: 'hi',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No');
    });

    it('returns error when resolveToken throws', async () => {
      deps = mockDeps({ resolveToken: vi.fn().mockRejectedValue(new Error('boom')) });
      router = new ChannelRouter(deps);

      const result = await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123',
        message: 'hi',
      });

      expect(result).toEqual({ success: false, error: 'boom' });
    });

    it('builds outbound with file attachment', async () => {
      await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123',
        message: 'see file',
        fileBase64: 'abc123',
        fileMimeType: 'application/pdf',
        fileName: 'doc.pdf',
      });

      const outbound = mockTransport.sendMessage.mock.calls[0][1];
      expect(outbound.attachments).toHaveLength(1);
      expect(outbound.attachments[0].type).toBe('file');
      expect(outbound.attachments[0].fileName).toBe('doc.pdf');
    });

    it('normalizes legacy imageBase64 to file attachment', async () => {
      await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123',
        message: 'see image',
        imageBase64: 'img123',
        imageMimeType: 'image/png',
      });

      const outbound = mockTransport.sendMessage.mock.calls[0][1];
      expect(outbound.attachments).toHaveLength(1);
      expect(outbound.attachments[0].type).toBe('image');
    });

    it('sends successfully even if resolvePersona throws', async () => {
      deps = mockDeps({ resolvePersona: vi.fn().mockRejectedValue(new Error('no slack')) });
      router = new ChannelRouter(deps);

      const result = await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123',
        message: 'hi',
      });

      expect(result).toEqual({ success: true });
      expect(mockTransport.sendMessage).toHaveBeenCalled();
    });

    it('prefers fileBase64 over imageBase64', async () => {
      await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123',
        message: 'both',
        fileBase64: 'file',
        fileMimeType: 'application/pdf',
        imageBase64: 'img',
        imageMimeType: 'image/png',
      });

      const outbound = mockTransport.sendMessage.mock.calls[0][1];
      expect(outbound.attachments).toHaveLength(1);
      expect(outbound.attachments[0].mimeType).toBe('application/pdf');
    });

    it('still succeeds if onReplySent throws after the message is sent', async () => {
      deps = mockDeps({ onReplySent: vi.fn().mockRejectedValue(new Error('side effect failed')) });
      router = new ChannelRouter(deps);

      const result = await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123',
        message: 'hi',
      });

      expect(result).toEqual({ success: true });
      expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
      expect(deps.onReplySent).toHaveBeenCalledWith('slack', 'C123');
    });
  });

  describe('sendInteractivePrompt', () => {
    it('dispatches to each target and returns refs with channelType', async () => {
      const prompt: InteractivePrompt = {
        id: 'p1',
        sessionId: 's1',
        type: 'approval',
        title: 'ok?',
        actions: [],
      };

      const refs = await router.sendInteractivePrompt({
        userId: 'u1',
        targets: [{ channelType: 'slack', channelId: 'C123:ts' }],
        prompt,
      });

      expect(refs).toHaveLength(1);
      expect(refs[0].channelType).toBe('slack');
      expect(refs[0].ref).toEqual({ channelId: 'C123', messageId: 'msg1' });
    });

    it('skips targets with no transport', async () => {
      const prompt: InteractivePrompt = {
        id: 'p1',
        sessionId: 's1',
        type: 'approval',
        title: 'ok?',
        actions: [],
      };

      const refs = await router.sendInteractivePrompt({
        userId: 'u1',
        targets: [{ channelType: 'unknown', channelId: 'X' }],
        prompt,
      });

      expect(refs).toHaveLength(0);
    });
  });

  describe('updateInteractivePrompt', () => {
    it('dispatches update to each ref', async () => {
      const resolution: InteractiveResolution = { actionId: 'approve', resolvedBy: 'user' };

      await router.updateInteractivePrompt({
        userId: 'u1',
        refs: [{ channelType: 'slack', ref: { channelId: 'C123', messageId: 'msg1' } }],
        resolution,
      });

      expect(mockTransport.updateInteractivePrompt).toHaveBeenCalledTimes(1);
    });

    it('swallows errors per-ref', async () => {
      mockTransport.updateInteractivePrompt.mockRejectedValueOnce(new Error('fail'));
      const resolution: InteractiveResolution = { actionId: 'approve', resolvedBy: 'user' };

      await router.updateInteractivePrompt({
        userId: 'u1',
        refs: [{ channelType: 'slack', ref: { channelId: 'C123', messageId: 'msg1' } }],
        resolution,
      });
    });
  });
});
