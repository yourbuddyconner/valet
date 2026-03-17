import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { SessionStatus } from '@/api/types';
import { useHibernateSession } from '@/api/sessions';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TerminateSessionDialog } from './terminate-session-dialog';
import { RefreshOrchestratorDialog } from './refresh-orchestrator-dialog';
import { DeleteSessionDialog } from './delete-session-dialog';

interface SessionActionsMenuProps {
  session: { id: string; workspace: string; status: SessionStatus };
  isOrchestrator?: boolean;
  trigger?: React.ReactNode;
  showOpen?: boolean;
  showEditorLink?: boolean;
  onActionComplete?: () => void;
  align?: 'start' | 'center' | 'end';
}

const ACTIVE_STATUSES: SessionStatus[] = ['running', 'idle', 'initializing', 'hibernated', 'restoring', 'hibernating'];
const REFRESHABLE_STATUSES: SessionStatus[] = [...ACTIVE_STATUSES, 'error'];
const HIBERNATABLE_STATUSES: SessionStatus[] = ['running'];
const DELETABLE_STATUSES: SessionStatus[] = ['terminated', 'archived', 'error'];

export function SessionActionsMenu({
  session,
  isOrchestrator = false,
  trigger,
  showOpen = false,
  showEditorLink = false,
  onActionComplete,
  align = 'end',
}: SessionActionsMenuProps) {
  const [dialog, setDialog] = useState<'terminate' | 'refresh' | 'delete' | null>(null);
  const hibernateMutation = useHibernateSession();

  const canTerminate = ACTIVE_STATUSES.includes(session.status);
  const canRefresh = REFRESHABLE_STATUSES.includes(session.status);
  const canHibernate = HIBERNATABLE_STATUSES.includes(session.status);
  const canDelete = DELETABLE_STATUSES.includes(session.status);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 px-0 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              <MoreVerticalIcon className="h-4 w-4" />
              <span className="sr-only">Session actions</span>
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          {showOpen && (
            <DropdownMenuItem asChild>
              <Link to="/sessions/$sessionId" params={{ sessionId: session.id }}>
                Open
              </Link>
            </DropdownMenuItem>
          )}
          {showEditorLink && (
            <DropdownMenuItem asChild>
              <Link to="/sessions/$sessionId" params={{ sessionId: session.id }}>
                Open in Editor
              </Link>
            </DropdownMenuItem>
          )}
          {(showOpen || showEditorLink) && (canHibernate || canTerminate || canDelete) && (
            <DropdownMenuSeparator />
          )}
          {canHibernate && (
            <DropdownMenuItem
              onClick={() => hibernateMutation.mutate(session.id)}
              disabled={hibernateMutation.isPending}
            >
              {hibernateMutation.isPending ? 'Hibernating...' : 'Hibernate Session'}
            </DropdownMenuItem>
          )}
          {canRefresh && isOrchestrator && (
            <DropdownMenuItem onClick={() => setDialog('refresh')}>
              Refresh Orchestrator
            </DropdownMenuItem>
          )}
          {canTerminate && !isOrchestrator && (
            <DropdownMenuItem
              onClick={() => setDialog('terminate')}
              className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
            >
              Terminate Session
            </DropdownMenuItem>
          )}
          {canDelete && !isOrchestrator && (
            <DropdownMenuItem
              onClick={() => setDialog('delete')}
              className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
            >
              Delete Session
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <TerminateSessionDialog
        sessionId={session.id}
        sessionName={session.workspace}
        open={dialog === 'terminate'}
        onOpenChange={(open) => !open && setDialog(null)}
        onTerminated={onActionComplete}
      />
      <RefreshOrchestratorDialog
        sessionId={session.id}
        open={dialog === 'refresh'}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <DeleteSessionDialog
        sessionId={session.id}
        sessionName={session.workspace}
        open={dialog === 'delete'}
        onOpenChange={(open) => !open && setDialog(null)}
        onDeleted={onActionComplete}
      />
    </>
  );
}

function MoreVerticalIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="19" r="1" />
    </svg>
  );
}
