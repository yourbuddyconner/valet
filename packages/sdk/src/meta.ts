// ─── Channel Metadata (display info for UI) ─────────────────────────────────

export interface ChannelCapabilities {
  supportsEditing: boolean;
  supportsDeleting: boolean;
  supportsThreads: boolean;
  supportsTypingIndicator: boolean;
  supportsAttachments: boolean;
}

export interface ChannelMeta {
  channelType: string;
  displayName: string;
  iconId: string;
  capabilities: ChannelCapabilities;
}

// ─── Known Channel Registry ─────────────────────────────────────────────────

const knownChannels: ChannelMeta[] = [
  {
    channelType: 'web',
    displayName: 'Web',
    iconId: 'web',
    capabilities: {
      supportsEditing: false,
      supportsDeleting: false,
      supportsThreads: false,
      supportsTypingIndicator: false,
      supportsAttachments: true,
    },
  },
  {
    channelType: 'telegram',
    displayName: 'Telegram',
    iconId: 'telegram',
    capabilities: {
      supportsEditing: true,
      supportsDeleting: true,
      supportsThreads: false,
      supportsTypingIndicator: true,
      supportsAttachments: true,
    },
  },
  {
    channelType: 'slack',
    displayName: 'Slack',
    iconId: 'slack',
    capabilities: {
      supportsEditing: true,
      supportsDeleting: true,
      supportsThreads: true,
      supportsTypingIndicator: true,
      supportsAttachments: true,
    },
  },
  {
    channelType: 'github',
    displayName: 'GitHub',
    iconId: 'github',
    capabilities: {
      supportsEditing: true,
      supportsDeleting: true,
      supportsThreads: true,
      supportsTypingIndicator: false,
      supportsAttachments: false,
    },
  },
  {
    channelType: 'api',
    displayName: 'API',
    iconId: 'api',
    capabilities: {
      supportsEditing: false,
      supportsDeleting: false,
      supportsThreads: false,
      supportsTypingIndicator: false,
      supportsAttachments: true,
    },
  },
];

const channelMetaMap = new Map<string, ChannelMeta>(
  knownChannels.map((m) => [m.channelType, m]),
);

/** Get display metadata for a channel type. Returns a generic fallback for unknown types. */
export function getChannelMeta(channelType: string): ChannelMeta {
  return channelMetaMap.get(channelType) ?? {
    channelType,
    displayName: channelType.charAt(0).toUpperCase() + channelType.slice(1),
    iconId: 'generic',
    capabilities: {
      supportsEditing: false,
      supportsDeleting: false,
      supportsThreads: false,
      supportsTypingIndicator: false,
      supportsAttachments: false,
    },
  };
}

/** List all known channel metadata entries. */
export function listChannelMeta(): ChannelMeta[] {
  return [...knownChannels];
}

/** Format a channel label for display (synchronous fallback — prefer resolveLabel from transport). */
export function formatChannelLabel(channelType: string, channelId: string): string {
  const meta = getChannelMeta(channelType);
  if (channelType === 'web') return meta.displayName;
  if (channelId === 'default') return meta.displayName;
  if (channelType === 'slack') {
    // Parse composite ID to show a better fallback than the raw string.
    // Formats: "teamId:channelId:threadTs", "channelId:threadTs", or bare ID.
    const parts = channelId.split(':');
    const isSlackId = (s: string) => /^[A-Z]/.test(s);
    const isThreadTs = (s: string) => /^\d+\.\d+$/.test(s);

    let hasThread = false;
    let slackId: string | undefined;

    if (parts.length >= 3 && isSlackId(parts[1])) {
      slackId = parts[1];
      hasThread = isThreadTs(parts[2]);
    } else if (parts.length === 2) {
      if (isSlackId(parts[0]) && isThreadTs(parts[1])) {
        slackId = parts[0]; hasThread = true;
      } else if (isSlackId(parts[1])) {
        slackId = parts[1];
      } else if (isSlackId(parts[0])) {
        slackId = parts[0];
      }
    } else if (isSlackId(parts[0])) {
      slackId = parts[0];
    }

    if (!slackId) {
      // channelId is a human-readable name (e.g. "general") — show as #channel
      const label = `Slack #${channelId}`;
      return hasThread ? `${label} (thread)` : label;
    }

    const prefix = slackId.startsWith('D') ? 'Slack DM' : slackId.startsWith('G') ? 'Slack Group DM' : `Slack #${slackId}`;
    return hasThread ? `${prefix} (thread)` : prefix;
  }
  return meta.displayName;
}
