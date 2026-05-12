import { useNavigate } from '@tanstack/react-router';
import type { AgentSession } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatRelativeTime } from '@/lib/format';
import { SessionActionsMenu } from './session-actions-menu';

interface SessionCardProps {
  session: AgentSession;
}

export function SessionCard({ session }: SessionCardProps) {
  const navigate = useNavigate();

  return (
    <Card
      className="cursor-pointer transition-colors hover:border-neutral-300"
      onClick={() => navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } })}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <CardTitle className="text-base">{session.workspace}</CardTitle>
          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <StatusBadge status={session.status} />
            <SessionActionsMenu
              session={session}
              showOpen={false}
              showEditorLink={true}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between text-sm text-neutral-500">
          <span className="truncate">ID: {session.id.slice(0, 8)}...</span>
          <span className="tabular-nums">
            {formatRelativeTime(session.lastActiveAt)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: AgentSession['status'] }) {
  const variants: Record<
    AgentSession['status'],
    'default' | 'success' | 'warning' | 'error' | 'secondary'
  > = {
    initializing: 'warning',
    waiting_runner: 'warning',
    recovering: 'warning',
    backoff: 'error',
    running: 'success',
    idle: 'default',
    hibernating: 'warning',
    hibernated: 'secondary',
    restoring: 'warning',
    terminated: 'secondary',
    archived: 'secondary',
    error: 'error',
  };

  return <Badge variant={variants[status]}>{status}</Badge>;
}
