import { cn } from '@/lib/cn';

interface CollaboratorsBarProps {
  connectedUsers: ConnectedUser[];
  className?: string;
}

export interface ConnectedUser {
  id: string;
  name?: string;
  avatarUrl?: string;
}

const COLORS = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-teal-500',
  'bg-cyan-500',
  'bg-orange-500',
];

function getColorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

function getInitials(name?: string, id?: string): string {
  if (name) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  return (id ?? '??').slice(0, 2).toUpperCase();
}

export function CollaboratorsBar({ connectedUsers, className }: CollaboratorsBarProps) {
  if (connectedUsers.length === 0) return null;

  return (
    <div className={cn('flex items-center -space-x-1.5', className)}>
      {connectedUsers.map((user) => (
        <div key={user.id} className="group relative">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.name || user.id}
              title={user.name || `User ${user.id.slice(0, 8)}`}
              aria-label={user.name || `User ${user.id.slice(0, 8)}`}
              className="h-6 w-6 rounded-full border-2 border-surface-0 ring-0 dark:border-surface-0"
            />
          ) : (
            <div
              title={user.name || `User ${user.id.slice(0, 8)}`}
              aria-label={user.name || `User ${user.id.slice(0, 8)}`}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface-0 font-mono text-[9px] font-semibold text-white dark:border-surface-0',
                getColorForUser(user.id)
              )}
            >
              {getInitials(user.name, user.id)}
            </div>
          )}
          {/* Tooltip */}
          <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded bg-neutral-900 px-2 py-1 font-mono text-[10px] text-white opacity-0 shadow-panel transition-opacity group-hover:opacity-100 dark:bg-neutral-700">
            {user.name || `User ${user.id.slice(0, 8)}`}
          </div>
        </div>
      ))}
      {connectedUsers.length > 1 && (
        <span className="pl-2.5 label-mono text-neutral-500 dark:text-neutral-400">
          {connectedUsers.length} online
        </span>
      )}
    </div>
  );
}
