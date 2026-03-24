/**
 * ChannelRouter — outbound channel dispatch service.
 *
 * Owns: active channel tracking, transport resolution, token resolution,
 * outbound message building, interactive prompt dispatch, and follow-up
 * lifecycle notifications.
 *
 * Helper class scoped to one SessionAgentDO instance. Constructed with
 * injected deps for testability.
 */

import type {
  ChannelContext,
  ChannelTarget,
  InteractivePrompt,
  InteractivePromptRef,
  InteractiveResolution,
  OutboundMessage,
} from '@valet/sdk';
import { channelRegistry } from '../channels/registry.js';

export type Persona = NonNullable<ChannelContext['persona']>;

export interface ChannelRouterDeps {
  resolveToken(channelType: string, userId: string): Promise<string | undefined>;
  resolvePersona(userId: string): Promise<Persona | undefined>;
  onReplySent(channelType: string, channelId: string): Promise<void>;
}

export interface SendReplyOpts {
  userId: string;
  channelType: string;
  channelId: string;
  message: string;
  fileBase64?: string;
  fileMimeType?: string;
  fileName?: string;
  imageBase64?: string;
  imageMimeType?: string;
  followUp?: boolean;
}

export interface SendReplyResult {
  success: boolean;
  error?: string;
}

export interface SendInteractivePromptOpts {
  userId: string;
  targets: Array<{ channelType: string; channelId: string }>;
  prompt: InteractivePrompt;
}

export interface UpdateInteractivePromptOpts {
  userId: string | undefined;
  refs: Array<{ channelType: string; ref: InteractivePromptRef }>;
  resolution: InteractiveResolution;
}

export class ChannelRouter {
  private _activeChannel: { channelType: string; channelId: string } | null = null;

  constructor(private readonly deps: ChannelRouterDeps) {}

  setActiveChannel(channel: { channelType: string; channelId: string }): void {
    this._activeChannel = { ...channel };
  }

  clearActiveChannel(): void {
    this._activeChannel = null;
  }

  get activeChannel(): { channelType: string; channelId: string } | null {
    return this._activeChannel ? { ...this._activeChannel } : null;
  }

  recoverActiveChannel(channelType: string, channelId: string): void {
    this._activeChannel = { channelType, channelId };
  }

  async sendReply(opts: SendReplyOpts): Promise<SendReplyResult> {
    const { userId, channelType, channelId, followUp } = opts;

    const transport = channelRegistry.getTransport(channelType);
    if (!transport) {
      return { success: false, error: `Unsupported channel type: ${channelType}` };
    }

    try {
      const token = await this.deps.resolveToken(channelType, userId);
      if (!token) {
        return { success: false, error: `No ${channelType} config for user` };
      }

      const target: ChannelTarget = transport.parseTarget?.(channelId) ?? { channelType, channelId };
      const outbound = this.buildOutboundMessage(opts);
      const persona = await this.deps.resolvePersona(userId).catch(() => undefined);
      const ctx: ChannelContext = { token, userId, persona };

      const result = await transport.sendMessage(target, outbound, ctx);
      if (!result.success) {
        return { success: false, error: result.error || `${channelType} API error` };
      }

      if (followUp !== false) {
        await this.deps.onReplySent(channelType, channelId).catch((err) => {
          console.warn(
            `[ChannelRouter] onReplySent failed for ${channelType}:${channelId}:`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    return { success: true };
  }

  async sendInteractivePrompt(
    opts: SendInteractivePromptOpts,
  ): Promise<Array<{ channelType: string; ref: InteractivePromptRef }>> {
    const { userId, targets, prompt } = opts;
    const refs: Array<{ channelType: string; ref: InteractivePromptRef }> = [];

    for (const t of targets) {
      const transport = channelRegistry.getTransport(t.channelType);
      if (!transport?.sendInteractivePrompt) continue;

      const token = await this.deps.resolveToken(t.channelType, userId);
      if (!token) continue;

      const target: ChannelTarget =
        transport.parseTarget?.(t.channelId) ?? { channelType: t.channelType, channelId: t.channelId };
      const ctx: ChannelContext = { token, userId };

      const ref = await transport.sendInteractivePrompt(target, prompt, ctx);
      if (ref) {
        refs.push({ channelType: t.channelType, ref });
      }
    }

    return refs;
  }

  async updateInteractivePrompt(opts: UpdateInteractivePromptOpts): Promise<void> {
    const { userId, refs, resolution } = opts;

    for (const { channelType, ref } of refs) {
      const transport = channelRegistry.getTransport(channelType);
      if (!transport?.updateInteractivePrompt) continue;

      const token = await this.deps.resolveToken(channelType, userId || '');
      if (!token) continue;

      const target: ChannelTarget =
        transport.parseTarget?.(ref.channelId) ?? { channelType, channelId: ref.channelId };
      const ctx: ChannelContext = { token, userId: userId || '' };

      try {
        await transport.updateInteractivePrompt(target, ref, resolution, ctx);
      } catch (err) {
        console.error(
          `[ChannelRouter] updateInteractivePrompt failed for ${channelType}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private buildOutboundMessage(opts: SendReplyOpts): OutboundMessage {
    const attachBase64 = opts.fileBase64 || opts.imageBase64;
    const attachMime = opts.fileMimeType || opts.imageMimeType || 'application/octet-stream';
    const attachName = opts.fileName;

    if (attachBase64) {
      return {
        markdown: opts.message || undefined,
        attachments: [
          {
            type: attachMime.startsWith('image/') ? 'image' : 'file',
            url: `data:${attachMime};base64,${attachBase64}`,
            mimeType: attachMime,
            fileName: attachName,
            caption: opts.message || undefined,
          },
        ],
      };
    }

    return { markdown: opts.message };
  }
}
