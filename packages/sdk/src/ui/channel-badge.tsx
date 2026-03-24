import type { JSX } from 'react';
import { getChannelMeta } from '../meta.js';
import { getChannelIcon } from './icons.js';

interface ChannelBadgeProps {
  channelType: string;
  className?: string;
}

/** Badge showing which channel a message arrived from (e.g. "via telegram"). */
export function ChannelBadge({ channelType, className }: ChannelBadgeProps): JSX.Element {
  const meta = getChannelMeta(channelType);
  const Icon = getChannelIcon(meta.iconId);
  return (
    <span className={className ?? 'inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 font-mono text-[9px] font-medium text-blue-500 dark:bg-blue-500/15 dark:text-blue-400'}>
      <Icon className="h-2.5 w-2.5" />
      via {meta.displayName.toLowerCase()}
    </span>
  );
}
