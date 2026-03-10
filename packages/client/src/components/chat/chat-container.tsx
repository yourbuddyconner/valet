import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { useChat } from '@/hooks/use-chat';
import type { IntegrationAuthError } from '@/hooks/use-chat';
import { useSession, useSessionGitState, useUpdateSessionTitle, useSessionChildren } from '@/api/sessions';
import { useActiveThread, useCreateThread } from '@/api/threads';
import { useDrawer } from '@/routes/sessions/$sessionId';
import { MessageList } from './message-list';
import { ChatInput } from './chat-input';
import { QuestionPrompt } from './question-prompt';
import { ActionApprovalCard } from '@/components/session/action-approval-card';
import { ThreadSidebar } from './thread-sidebar';
import { SessionActionsMenu } from '@/components/sessions/session-actions-menu';
import { ShareSessionDialog } from '@/components/sessions/share-session-dialog';
import { api } from '@/api/client';
import type { QueueMode } from '@valet/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthStore } from '@/stores/auth';
import { useIsMobile } from '@/hooks/use-is-mobile';

// Module-level store for continuation context to avoid URL search param size limits
let pendingContinuationStore: { threadId: string; context: string } | null = null;
export function setPendingContinuation(threadId: string, context: string) {
  pendingContinuationStore = { threadId, context };
}
export function consumePendingContinuation(threadId: string): string | null {
  if (pendingContinuationStore?.threadId === threadId) {
    const ctx = pendingContinuationStore.context;
    pendingContinuationStore = null;
    return ctx;
  }
  return null;
}

interface ChatContainerProps {
  sessionId: string;
  initialThreadId?: string;
  initialContinuationContext?: string;
}

function isFinalSessionStatus(status: string) {
  return status === 'terminated' || status === 'archived';
}

export function ChatContainer({ sessionId, initialThreadId, initialContinuationContext }: ChatContainerProps) {
  const router = useRouter();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { data: session } = useSession(sessionId);
  const { data: gitState } = useSessionGitState(sessionId);
  const { data: childSessions } = useSessionChildren(sessionId);
  const updateTitle = useUpdateSessionTitle();
  const drawer = useDrawer();
  const authUser = useAuthStore((s) => s.user);
  const {
    messages,
    sessionStatus,
    pendingQuestions,
    connectionStatus,
    isConnected,
    runnerConnected,
    isAgentThinking,
    agentStatus,
    agentStatusDetail,
    availableModels,
    selectedModel,
    setSelectedModel,
    sendMessage,
    answerQuestion,
    abort,
    revertMessage,
    logEntries,
    sessionTitle,
    childSessionEvents,
    connectedUsers,
    executeCommand,
    pendingActionApprovals,
    approveActionWs,
    denyActionWs,
    integrationAuthErrors,
    dismissIntegrationAuth,
  } = useChat(sessionId);
  type QueuedAttachments = Parameters<typeof sendMessage>[2];
  type QueuedPrompt = {
    id: string;
    content: string;
    model?: string;
    attachments?: QueuedAttachments;
  };
  const [stagedQueuedPrompts, setStagedQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queueModePreference = (authUser?.uiQueueMode ?? 'followup') as QueueMode;
  const isDispatchBusy = isAgentThinking
    || agentStatus === 'thinking'
    || agentStatus === 'tool_calling'
    || agentStatus === 'streaming'
    || agentStatus === 'queued';

  // Sync log entries to the editor drawer context
  useEffect(() => {
    drawer.setLogEntries(logEntries);
  }, [logEntries, drawer.setLogEntries]);

  // Sync connected users and selected model to layout context for sidebar
  useEffect(() => {
    drawer.setConnectedUsers(connectedUsers);
  }, [connectedUsers, drawer.setConnectedUsers]);

  useEffect(() => {
    drawer.setSelectedModel(selectedModel);
  }, [selectedModel, drawer.setSelectedModel]);


  // Thread state (orchestrator sessions only)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreadId ?? null);
  const pendingContinuationContext = useRef<string | undefined>(
    initialContinuationContext ?? (initialThreadId ? (consumePendingContinuation(initialThreadId) ?? undefined) : undefined)
  );
  const isOrchestrator = session?.isOrchestrator === true;
  const createThread = useCreateThread(sessionId);

  // Auto-select the active thread on mount for orchestrator sessions when no
  // threadId was provided in the URL. The endpoint returns the current active
  // thread (or creates one if none exists), so we always land on the right thread.
  const { data: serverActiveThread } = useActiveThread(
    sessionId,
    isOrchestrator && !initialThreadId,
  );
  useEffect(() => {
    if (serverActiveThread && !activeThreadId) {
      setActiveThreadId(serverActiveThread.id);
    }
  }, [serverActiveThread, activeThreadId, setActiveThreadId]);

  const handleNewThread = useCallback(async () => {
    try {
      const thread = await createThread.mutateAsync();
      setActiveThreadId(thread.id);
    } catch (err) {
      console.error('[ChatContainer] Failed to create thread:', err);
    }
  }, [createThread]);

  // While the active thread is still resolving for orchestrator sessions,
  // show no messages to avoid a flash of unfiltered content.
  const isResolvingThread = isOrchestrator && !initialThreadId && !activeThreadId;

  const filteredMessages = useMemo(() => {
    if (isResolvingThread) return [];
    let filtered = messages;
    if (activeThreadId) {
      filtered = filtered.filter((msg) => msg.threadId === activeThreadId);
    }
    return filtered;
  }, [messages, activeThreadId, isResolvingThread]);

  const handleSendMessage = useCallback(
    async (content: string, model?: string, attachments?: Parameters<typeof sendMessage>[2]) => {
      if (queueModePreference === 'followup' && isDispatchBusy) {
        setStagedQueuedPrompts((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            content,
            model,
            attachments,
          },
        ]);
        return;
      }

      const continuation = pendingContinuationContext.current;
      pendingContinuationContext.current = undefined;
      sendMessage(content, model, attachments, undefined, undefined, queueModePreference, activeThreadId ?? undefined, continuation);
    },
    [sendMessage, queueModePreference, isDispatchBusy, activeThreadId]
  );

  const handleAbort = useCallback(() => {
    abort();
  }, [abort]);

  const handleCommand = useCallback(
    (command: string, args?: string) => {
      executeCommand(command, args);
    },
    [executeCommand]
  );

  const steerLatestQueuedPrompt = useCallback(() => {
    if (!isConnected || stagedQueuedPrompts.length === 0) return;
    const latest = stagedQueuedPrompts[stagedQueuedPrompts.length - 1];
    setStagedQueuedPrompts((prev) => prev.slice(0, -1));
    sendMessage(
      latest.content,
      latest.model,
      latest.attachments,
      undefined,
      undefined,
      'steer',
    );
  }, [isConnected, stagedQueuedPrompts, sendMessage]);

  useEffect(() => {
    if (!isConnected) return;
    if (isDispatchBusy) return;
    if (stagedQueuedPrompts.length === 0) return;

    const nextPrompt = stagedQueuedPrompts[0];
    setStagedQueuedPrompts((prev) => prev.slice(1));
    sendMessage(
      nextPrompt.content,
      nextPrompt.model,
      nextPrompt.attachments,
      undefined,
      undefined,
      'followup',
    );
  }, [isConnected, isDispatchBusy, stagedQueuedPrompts, sendMessage]);

  // Share dialog state
  const [shareOpen, setShareOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const isOwner = session?.userId === authUser?.id;
  const canShareSession = session?.isOrchestrator !== true;

  // Editable title state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const displayTitle = sessionTitle || session?.title || session?.workspace || sessionId.slice(0, 8);

  const startEditingTitle = useCallback(() => {
    setEditTitleValue(sessionTitle || session?.title || '');
    setIsEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.focus());
  }, [sessionTitle, session?.title]);

  const saveTitle = useCallback(() => {
    const trimmed = editTitleValue.trim();
    if (trimmed && trimmed !== (sessionTitle || session?.title)) {
      updateTitle.mutate({ sessionId, title: trimmed });
    }
    setIsEditingTitle(false);
  }, [editTitleValue, sessionTitle, session?.title, sessionId, updateTitle]);

  const isLoading = connectionStatus === 'connecting';
  const isTerminated = isFinalSessionStatus(sessionStatus);
  const isDisabled = !isConnected || isTerminated;
  const isAgentActive = (isAgentThinking && agentStatus !== 'queued') || agentStatus === 'thinking' || agentStatus === 'tool_calling' || agentStatus === 'streaming';
  const displaySessionStatus = !isTerminated && agentStatus === 'queued' && !runnerConnected
    ? 'restoring'
    : sessionStatus;
  const hideChrome = isMobile && composerFocused;

  // Clear any stale overlay (no longer using layout-level transition overlays)
  useEffect(() => {
    drawer.setOverlay(null);
  }, [drawer.setOverlay]);

  // Global Escape key handler for abort
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isAgentActive) {
        e.preventDefault();
        handleAbort();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAgentActive, handleAbort]);

  return (
    <div className="flex h-full flex-col">
      {/* Header — Title bar */}
      {!hideChrome && (
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface-0 px-3 dark:bg-surface-0">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200" onClick={() => session?.isOrchestrator ? navigate({ to: '/orchestrator' }) : router.history.back()}>
              <BackIcon className="h-3.5 w-3.5" />
            </Button>
            <div className="h-3 w-px bg-neutral-200 dark:bg-neutral-800" />

            {/* Editable session title */}
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                value={editTitleValue}
                onChange={(e) => setEditTitleValue(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveTitle();
                  if (e.key === 'Escape') setIsEditingTitle(false);
                }}
                className="min-w-[120px] max-w-[300px] rounded-sm border border-accent/30 bg-transparent px-1.5 py-0.5 font-sans text-[13px] font-semibold text-neutral-900 outline-none selection:bg-accent/20 dark:text-neutral-100"
                placeholder="Session title..."
              />
            ) : (
              <button
                onClick={startEditingTitle}
                className="group flex items-center gap-1.5 truncate rounded-sm px-1 py-0.5 text-[13px] font-semibold text-neutral-900 transition-colors hover:bg-surface-1 dark:text-neutral-100 dark:hover:bg-surface-2"
                title="Click to edit title"
              >
                <span className="truncate">{displayTitle}</span>
                <PencilIcon className="h-2.5 w-2.5 shrink-0 text-neutral-300 opacity-0 transition-opacity group-hover:opacity-100 dark:text-neutral-600" />
              </button>
            )}

            <SessionStatusBadge
              status={displaySessionStatus}
              errorMessage={session?.errorMessage}
            />
            <SessionStatusIndicator sessionStatus={displaySessionStatus} connectionStatus={connectionStatus} />
          </div>
          <div className="flex items-center gap-0.5">
            {canShareSession && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShareOpen(true)}
                className="h-6 gap-1 px-1.5 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200"
                title="Share session"
              >
                <ShareIcon className="h-3.5 w-3.5" />
              </Button>
            )}
            {session && (
              <SessionActionsMenu
                session={{ id: sessionId, workspace: session.workspace, status: sessionStatus }}
                isOrchestrator={session.isOrchestrator}
                showOpen={false}
                showEditorLink={false}
              />
            )}
          </div>
        </header>
      )}

      {/* Desktop action toolbar */}
      {!isMobile && (
        <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-neutral-100 bg-surface-0 px-2 dark:border-neutral-800/50 dark:bg-surface-0">
          <Button variant="ghost" size="sm" onClick={drawer.toggleVscode} className="h-6 gap-1 px-2 text-[11px] font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
            <EditorIcon className="h-3 w-3" />
            VS Code
          </Button>
          <Button variant="ghost" size="sm" onClick={drawer.toggleDesktop} className="h-6 gap-1 px-2 text-[11px] font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
            <DesktopIcon className="h-3 w-3" />
            Desktop
          </Button>
          <Button variant="ghost" size="sm" onClick={drawer.toggleTerminal} className="h-6 gap-1 px-2 text-[11px] font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
            <TerminalIcon className="h-3 w-3" />
            Terminal
          </Button>
          <Button variant="ghost" size="sm" onClick={drawer.toggleFiles} className="h-6 gap-1 px-2 text-[11px] font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
            <FilesIcon className="h-3 w-3" />
            Files
          </Button>
          <Button variant="ghost" size="sm" onClick={drawer.toggleReview} className="h-6 gap-1 px-2 text-[11px] font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
            <ReviewIcon className="h-3 w-3" />
            Review
          </Button>
          <Button variant="ghost" size="sm" onClick={drawer.toggleLogs} className="h-6 gap-1 px-2 text-[11px] font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
            <LogsIcon className="h-3 w-3" />
            Logs
          </Button>
          {gitState?.prUrl && (
            <a href={gitState.prUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px] font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
                <PRIcon className="h-3 w-3" />
                PR
                {gitState.prState && (
                  <Badge
                    variant={
                      gitState.prState === 'merged' ? 'default'
                        : gitState.prState === 'open' ? 'success'
                        : gitState.prState === 'draft' ? 'secondary'
                        : 'error'
                    }
                    className="ml-0.5 text-2xs"
                  >
                    {gitState.prState}
                  </Badge>
                )}
              </Button>
            </a>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={drawer.toggleSidebar} title="Toggle session info sidebar" className="h-6 px-1.5 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">
            <InfoIcon className="h-3 w-3" />
          </Button>
        </div>
      )}

      {canShareSession && (
        <ShareSessionDialog
          sessionId={sessionId}
          open={shareOpen}
          onOpenChange={setShareOpen}
          isOwner={isOwner}
        />
      )}

      {isLoading ? (
        <ChatSkeleton />
      ) : (
        <div className="flex min-h-0 flex-1 flex-row">
          {isOrchestrator && (
            <ThreadSidebar
              sessionId={sessionId}
              activeThreadId={activeThreadId}
              onSelectThread={setActiveThreadId}
              onNewThread={handleNewThread}
            />
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            <MessageList
              messages={filteredMessages}
              isAgentThinking={isAgentThinking}
              agentStatus={agentStatus}
              agentStatusDetail={agentStatusDetail}
              onRevert={revertMessage}
              childSessionEvents={childSessionEvents}
              childSessions={childSessions}
              connectedUsers={connectedUsers}
            />
          </div>
          {pendingQuestions.map((q) => (
            <QuestionPrompt
              key={q.questionId}
              questionId={q.questionId}
              text={q.text}
              options={q.options}
              expiresAt={q.expiresAt}
              onAnswer={answerQuestion}
            />
          ))}
          {pendingActionApprovals.map((a) => (
            <ActionApprovalCard
              key={a.invocationId}
              approval={a}
              onApproveWs={approveActionWs}
              onDenyWs={denyActionWs}
            />
          ))}
          {integrationAuthErrors.length > 0 && (
            <IntegrationReauthBanner
              errors={integrationAuthErrors}
              onDismiss={dismissIntegrationAuth}
            />
          )}
          {stagedQueuedPrompts.length > 0 && (
            <div className="border-t border-neutral-100 bg-surface-0 px-3 py-2 dark:border-neutral-800/50 dark:bg-surface-0">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-[10px] text-amber-700 dark:text-amber-300">
                  {stagedQueuedPrompts.length} queued locally - Enter again to steer latest
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={steerLatestQueuedPrompt}
                    className="rounded px-1.5 py-0.5 font-mono text-[10px] text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/30"
                  >
                    steer latest
                  </button>
                  <button
                    type="button"
                    onClick={() => setStagedQueuedPrompts([])}
                    className="rounded px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                  >
                    clear
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                {stagedQueuedPrompts.slice(-3).map((queued) => (
                  <div
                    key={queued.id}
                    className="rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1 font-mono text-[11px] text-amber-900 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-100"
                  >
                    <div className="truncate">
                      {queued.content || `[${queued.attachments?.length ?? 0} attachment(s)]`}
                    </div>
                  </div>
                ))}
                {stagedQueuedPrompts.length > 3 && (
                  <div className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                    +{stagedQueuedPrompts.length - 3} more queued
                  </div>
                )}
              </div>
            </div>
          )}
          <ChatInput
            onSend={handleSendMessage}
            onSteerQueued={steerLatestQueuedPrompt}
            hasQueuedDraft={stagedQueuedPrompts.length > 0}
            disabled={isDisabled}
            sendDisabled={false}

            placeholder={
              isDisabled
                ? 'Session is not available'
                : 'Ask or build anything...'
            }
            availableModels={availableModels}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            onAbort={handleAbort}
            isAgentActive={isAgentActive}
            sessionId={sessionId}
            sessionStatus={sessionStatus}
            compact={drawer.activePanel !== null || isMobile}
            showActionsButton={isMobile}
            onOpenActions={() => setMobileActionsOpen(true)}
            onFocusChange={setComposerFocused}
            onCommand={handleCommand}
          />
          {isMobile && (
            <MobileActionsSheet
              open={mobileActionsOpen}
              onOpenChange={setMobileActionsOpen}
              onVscode={() => drawer.openVscode()}
              onDesktop={() => drawer.openDesktop()}
              onTerminal={() => drawer.openTerminal()}
              onFiles={() => drawer.openFiles()}
              onReview={() => drawer.openReview()}
              onLogs={() => drawer.openLogs()}
              onInfo={() => drawer.toggleSidebar()}
              onShare={canShareSession ? () => setShareOpen(true) : undefined}
              prUrl={gitState?.prUrl || undefined}
            />
          )}
        </div>
        </div>
      )}
    </div>
  );
}

function SessionStatusBadge({ status, errorMessage }: { status: string; errorMessage?: string }) {
  const variants: Record<
    string,
    'default' | 'success' | 'warning' | 'error' | 'secondary'
  > = {
    initializing: 'warning',
    running: 'success',
    idle: 'default',
    hibernating: 'warning',
    hibernated: 'secondary',
    restoring: 'warning',
    terminated: 'secondary',
    archived: 'secondary',
    error: 'error',
  };

  return <Badge variant={variants[status] ?? 'default'} title={errorMessage}>{status}</Badge>;
}

function SessionStatusIndicator({ sessionStatus, connectionStatus }: { sessionStatus: string; connectionStatus: string }) {
  // Determine color and animation based on session state
  const isTransitioning = sessionStatus === 'hibernating' || sessionStatus === 'restoring' || sessionStatus === 'initializing';
  const isRunning = sessionStatus === 'running' || sessionStatus === 'idle';
  const isSleeping = sessionStatus === 'hibernated';
  const isTerminated = sessionStatus === 'terminated' || sessionStatus === 'archived';
  const isError = sessionStatus === 'error' || connectionStatus === 'error';
  const isDisconnected = connectionStatus === 'disconnected' || connectionStatus === 'connecting';

  let color = 'bg-neutral-300 dark:bg-neutral-600';
  let title = sessionStatus;
  let pulse = false;
  let spin = false;

  if (isError) {
    color = 'bg-red-400';
    title = 'Error';
  } else if (isTerminated) {
    color = 'bg-neutral-300 dark:bg-neutral-600';
    title = 'Terminated';
  } else if (isTransitioning) {
    color = 'bg-amber-400';
    title = sessionStatus === 'initializing' ? 'Starting...' : sessionStatus === 'hibernating' ? 'Hibernating...' : 'Waking...';
    spin = true;
  } else if (isSleeping) {
    color = 'bg-neutral-400 dark:bg-neutral-500';
    title = 'Hibernated';
    pulse = true;
  } else if (isDisconnected) {
    color = 'bg-amber-400';
    title = 'Reconnecting...';
    spin = true;
  } else if (isRunning) {
    color = 'bg-emerald-500';
    title = 'Live';
    pulse = true;
  }

  return (
    <div className="relative flex items-center justify-center" title={title}>
      <div className={`h-1.5 w-1.5 rounded-full ${color} ${spin ? 'animate-spin-slow' : ''}`} />
      {pulse && !spin && (
        <div
          className={`absolute h-2.5 w-2.5 rounded-full border ${
            isRunning
              ? 'border-emerald-500/30'
              : 'border-neutral-400/20 dark:border-neutral-500/20'
          } animate-ping`}
          style={{ animationDuration: isRunning ? '2s' : '3s' }}
        />
      )}
      {spin && (
        <div className="absolute h-3 w-3">
          <div
            className={`h-full w-full rounded-full border border-transparent ${
              isTransitioning ? 'border-t-amber-400/60' : 'border-t-amber-400/60'
            } animate-spin`}
            style={{ animationDuration: '1s' }}
          />
        </div>
      )}
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div className="flex-1 p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-6 w-6 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-16 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function IntegrationReauthBanner({
  errors,
  onDismiss,
}: {
  errors: IntegrationAuthError[];
  onDismiss: (service: string) => void;
}) {
  const queryClient = useQueryClient();

  const handleReauthorize = useCallback(async (service: string) => {
    try {
      const redirectUri = `${window.location.origin}/integrations/callback`;
      const response = await api.get<{ url: string; state: string; code_verifier?: string }>(
        `/integrations/${service}/oauth?redirect_uri=${encodeURIComponent(redirectUri)}`
      );

      // Store OAuth state in localStorage (not sessionStorage — popups don't share sessionStorage)
      localStorage.setItem('oauth_state', response.state);
      localStorage.setItem('oauth_service', service);
      if (response.code_verifier) {
        localStorage.setItem('oauth_code_verifier', response.code_verifier);
      }

      // Listen for completion message from popup
      const handleMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'oauth-complete' && event.data?.service === service) {
          window.removeEventListener('message', handleMessage);
          onDismiss(service);
          queryClient.invalidateQueries({ queryKey: ['integrations'] });
        }
      };
      window.addEventListener('message', handleMessage);

      // Open OAuth flow in popup
      const popup = window.open(response.url, `reauth-${service}`, 'width=600,height=700,popup=yes');

      // Clean up listener if popup is blocked or closes without completing
      if (!popup) {
        window.removeEventListener('message', handleMessage);
        console.warn(`[ReauthBanner] Popup blocked for ${service}`);
        return;
      }
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          window.removeEventListener('message', handleMessage);
        }
      }, 500);
    } catch (err) {
      console.error(`[ReauthBanner] Failed to initiate OAuth for ${service}:`, err);
    }
  }, [onDismiss, queryClient]);

  return (
    <div className="border-t border-amber-200 bg-amber-50/80 px-3 py-2 dark:border-amber-800/50 dark:bg-amber-900/20">
      <div className="flex items-start gap-2">
        <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] font-medium text-amber-800 dark:text-amber-200">
            Integration authorization expired
          </p>
          <div className="mt-1 space-y-1">
            {errors.map((err) => (
              <div key={err.service} className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
                  {err.displayName}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleReauthorize(err.service)}
                  className="h-5 px-1.5 font-mono text-[10px] font-semibold text-amber-700 hover:bg-amber-200/60 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-800/40 dark:hover:text-amber-100"
                >
                  Reauthorize
                </Button>
                <button
                  type="button"
                  onClick={() => onDismiss(err.service)}
                  className="ml-auto rounded p-0.5 text-amber-400 transition-colors hover:text-amber-700 dark:text-amber-600 dark:hover:text-amber-300"
                  title="Dismiss"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

interface MobileActionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVscode: () => void;
  onDesktop: () => void;
  onTerminal: () => void;
  onFiles: () => void;
  onReview: () => void;
  onLogs: () => void;
  onInfo: () => void;
  onShare?: () => void;
  prUrl?: string;
}

function MobileActionsSheet({
  open,
  onOpenChange,
  onVscode,
  onDesktop,
  onTerminal,
  onFiles,
  onReview,
  onLogs,
  onInfo,
  onShare,
  prUrl,
}: MobileActionsSheetProps) {
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-[61] rounded-t-2xl border-t border-neutral-200 bg-surface-0 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-2xl dark:border-neutral-800 dark:bg-surface-1">
          <Dialog.Title className="mb-2 px-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
            Actions
          </Dialog.Title>
          <div className="grid grid-cols-2 gap-2">
            <MobileActionButton icon={<EditorIcon className="h-4 w-4" />} label="VS Code" onClick={() => run(onVscode)} />
            <MobileActionButton icon={<DesktopIcon className="h-4 w-4" />} label="Desktop" onClick={() => run(onDesktop)} />
            <MobileActionButton icon={<TerminalIcon className="h-4 w-4" />} label="Terminal" onClick={() => run(onTerminal)} />
            <MobileActionButton icon={<FilesIcon className="h-4 w-4" />} label="Files" onClick={() => run(onFiles)} />
            <MobileActionButton icon={<ReviewIcon className="h-4 w-4" />} label="Review" onClick={() => run(onReview)} />
            <MobileActionButton icon={<LogsIcon className="h-4 w-4" />} label="Logs" onClick={() => run(onLogs)} />
            <MobileActionButton icon={<InfoIcon className="h-4 w-4" />} label="Session Info" onClick={() => run(onInfo)} />
            {onShare && (
              <MobileActionButton icon={<ShareIcon className="h-4 w-4" />} label="Share" onClick={() => run(onShare)} />
            )}
            {prUrl && (
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="col-span-2 flex h-11 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-surface-1 px-3 text-[13px] font-medium text-neutral-700 dark:border-neutral-700 dark:bg-surface-2 dark:text-neutral-300"
                onClick={() => onOpenChange(false)}
              >
                <PRIcon className="h-4 w-4" />
                Open PR
              </a>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MobileActionButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-11 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-surface-1 px-3 text-[13px] font-medium text-neutral-700 active:scale-[0.98] dark:border-neutral-700 dark:bg-surface-2 dark:text-neutral-300"
    >
      {icon}
      {label}
    </button>
  );
}

function BackIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function EditorIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function FilesIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function ReviewIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function PRIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" x2="6" y1="9" y2="21" />
    </svg>
  );
}

function LogsIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M13 12h8" />
      <path d="M13 18h8" />
      <path d="M13 6h8" />
      <path d="M3 12h1" />
      <path d="M3 18h1" />
      <path d="M3 6h1" />
      <path d="M8 12h1" />
      <path d="M8 18h1" />
      <path d="M8 6h1" />
    </svg>
  );
}

function DesktopIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" x2="12" y1="2" y2="15" />
    </svg>
  );
}
