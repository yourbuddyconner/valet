import { useMemo } from 'react';
import type { Message } from '@/api/types';
import { formatChannelLabel } from '@valet/sdk';
import { getChannelIcon, ChannelsIcon } from '@valet/sdk/ui';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

export interface ChannelOption {
  label: string;
  channelType: string;
  channelId: string;
  messageCount: number;
}

/** Scan messages for unique channelType:channelId pairs. */
export function deriveChannels(messages: Message[]): ChannelOption[] {
  const counts = new Map<string, { channelType: string; channelId: string; count: number }>();

  for (const msg of messages) {
    const ct = msg.channelType || 'web';
    const ci = msg.channelId || 'default';
    const key = `${ct}:${ci}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { channelType: ct, channelId: ci, count: 1 });
    }
  }

  return Array.from(counts.values())
    .sort((a, b) => {
      // web first, then alphabetical
      if (a.channelType === 'web' && b.channelType !== 'web') return -1;
      if (b.channelType === 'web' && a.channelType !== 'web') return 1;
      return a.channelType.localeCompare(b.channelType) || a.channelId.localeCompare(b.channelId);
    })
    .map((c) => ({
      label: formatChannelLabel(c.channelType, c.channelId),
      channelType: c.channelType,
      channelId: c.channelId,
      messageCount: c.count,
    }));
}

function ChannelIconForType({ channelType }: { channelType: string }) {
  const Icon = getChannelIcon(channelType);
  return <Icon className="h-3 w-3" />;
}

interface ChannelSwitcherProps {
  channels: ChannelOption[];
  selectedChannel: string | null; // "channelType:channelId" or null for all
  onSelectChannel: (key: string | null) => void;
}

export function ChannelSwitcher({ channels, selectedChannel, onSelectChannel }: ChannelSwitcherProps) {
  const selectedOption = useMemo(
    () => (selectedChannel ? channels.find((c) => `${c.channelType}:${c.channelId}` === selectedChannel) : null),
    [channels, selectedChannel]
  );

  const label = selectedOption ? selectedOption.label : 'All channels';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium text-neutral-500 transition-colors hover:bg-surface-1 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-surface-2 dark:hover:text-neutral-200"
        >
          {selectedOption ? <ChannelIconForType channelType={selectedOption.channelType} /> : <ChannelsIcon className="h-3 w-3" />}
          <span>{label}</span>
          <ChevronDownIcon className="h-2.5 w-2.5 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        <DropdownMenuItem
          onClick={() => onSelectChannel(null)}
          className={!selectedChannel ? 'bg-surface-2 font-semibold' : ''}
        >
          <ChannelsIcon className="mr-2 h-3 w-3 text-neutral-400" />
          <span className="flex-1">All channels</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {channels.map((ch) => {
          const key = `${ch.channelType}:${ch.channelId}`;
          return (
            <DropdownMenuItem
              key={key}
              onClick={() => onSelectChannel(key)}
              className={selectedChannel === key ? 'bg-surface-2 font-semibold' : ''}
            >
              <span className="mr-2"><ChannelIconForType channelType={ch.channelType} /></span>
              <span className="flex-1">{ch.label}</span>
              <span className="ml-2 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                {ch.messageCount}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
