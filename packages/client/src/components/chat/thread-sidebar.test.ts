import { describe, expect, it } from 'vitest';
import { groupThreadsByChannel } from './thread-sidebar';
import type { SessionThread } from '@/api/types';

const baseThread = (overrides: Partial<SessionThread>): SessionThread => ({
  id: overrides.id ?? 'thread',
  sessionId: 'orchestrator:user-1',
  summaryAdditions: 0,
  summaryDeletions: 0,
  summaryFiles: 0,
  status: 'active',
  messageCount: 1,
  createdAt: new Date('2026-06-11T00:00:00Z'),
  lastActiveAt: new Date('2026-06-11T00:00:00Z'),
  ...overrides,
});

describe('groupThreadsByChannel', () => {
  it('uses automation origin before Slack routing metadata', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'automation-thread',
        originType: 'automation',
        channelType: 'slack',
        channelId: 'D123',
      }),
    ], new Map());

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      channelKey: 'automation:default',
      channelType: 'automation',
      channelId: 'default',
      label: 'Automations',
    });
  });

  it('keeps web-origin threads under Web even after Slack mappings exist', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'web-thread',
        originType: 'web',
        channelType: 'slack',
        channelId: 'D123',
      }),
    ], new Map());

    expect(groups[0]).toMatchObject({
      channelKey: 'web:default',
      channelType: 'web',
      channelId: 'default',
      label: 'Web',
    });
  });

  it('uses Slack origin channel labels for Slack-origin threads', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'slack-thread',
        originType: 'slack',
        originChannelType: 'slack',
        originChannelId: 'C123',
      }),
    ], new Map([['slack:C123', 'Slack #alerts']]));

    expect(groups[0]).toMatchObject({
      channelKey: 'slack:C123',
      channelType: 'slack',
      channelId: 'C123',
      label: 'Slack #alerts',
    });
  });

  it('falls back to legacy channel metadata when origin is missing', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'legacy-thread',
        channelType: 'slack',
        channelId: 'D123',
      }),
    ], new Map([['slack:D123', 'Slack DM']]));

    expect(groups[0]).toMatchObject({
      channelKey: 'slack:D123',
      label: 'Slack DM',
    });
  });

  it('sorts Web first, Automations second, then other channel labels', () => {
    const groups = groupThreadsByChannel([
      baseThread({
        id: 'slack-thread',
        originType: 'slack',
        originChannelType: 'slack',
        originChannelId: 'C123',
      }),
      baseThread({
        id: 'automation-thread',
        originType: 'automation',
      }),
      baseThread({
        id: 'web-thread',
        originType: 'web',
      }),
      baseThread({
        id: 'telegram-thread',
        originType: 'telegram',
        originChannelType: 'telegram',
        originChannelId: 'T123',
      }),
    ], new Map([
      ['slack:C123', 'Slack #alerts'],
      ['telegram:T123', 'Telegram'],
    ]));

    expect(groups.map((group) => group.channelKey)).toEqual([
      'web:default',
      'automation:default',
      'slack:C123',
      'telegram:T123',
    ]);
  });
});
