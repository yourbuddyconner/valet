import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useCreateSession, useAvailableModels } from '@/api/sessions';
import { useRepos, useValidateRepo, useRepoPulls, useRepoIssues, type Repo, type RepoPull, type RepoIssue } from '@/api/repos';
import { getWebSocketUrl } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import type { SessionSourceType } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { PersonaPicker } from '@/components/personas/persona-picker';
import { usePersonas } from '@/api/personas';
import { useOrgRepos } from '@/api/org-repos';
import type { SessionStatus, CreateSessionResponse } from '@/api/types';

interface CreateSessionDialogProps {
  trigger?: React.ReactNode;
}

type DialogView = 'form' | 'progress';
type RepoMode = 'my-repos' | 'url' | 'from-pr' | 'from-issue';

// --- Progress step definitions ---

interface ProgressStep {
  key: string;
  label: string;
}

const PROGRESS_STEPS: ProgressStep[] = [
  { key: 'creating', label: 'Creating session' },
  { key: 'spawning', label: 'Spawning sandbox' },
  { key: 'cloning', label: 'Cloning repository' },
  { key: 'starting', label: 'Starting agent' },
  { key: 'ready', label: 'Ready' },
];

// --- Session status WebSocket hook ---

function useSessionStatus(sessionId: string | null) {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [runnerConnected, setRunnerConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Track latest values in refs so the message handler can check both conditions
  const statusRef = useRef<SessionStatus | null>(null);
  const runnerConnectedRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;

    const { token } = useAuthStore.getState();
    if (!token) return;

    const wsUrlStr = getWebSocketUrl(`/api/sessions/${sessionId}/ws?role=client`);
    const wsUrl = new URL(wsUrlStr);
    wsUrl.searchParams.delete('userId');
    wsUrl.searchParams.delete('token');
    const ws = new WebSocket(wsUrl.toString(), ['valet', `bearer.${token}`]);
    wsRef.current = ws;

    const closeIfReady = () => {
      if (statusRef.current === 'running' && runnerConnectedRef.current) {
        ws.close();
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Listen for init message (contains current session status)
        if (msg.type === 'init' && msg.session?.status) {
          statusRef.current = msg.session.status;
          setStatus(msg.session.status as SessionStatus);
          if (msg.data?.runnerConnected) {
            runnerConnectedRef.current = true;
            setRunnerConnected(true);
          }
          if (msg.session.status === 'error') {
            ws.close();
            return;
          }
          closeIfReady();
        }
        // Listen for status update messages
        if (msg.type === 'status') {
          if (msg.data?.status) {
            statusRef.current = msg.data.status;
            setStatus(msg.data.status as SessionStatus);
            if (msg.data.status === 'error') {
              ws.close();
              if (msg.data.error) {
                setError(msg.data.error);
              }
              return;
            }
          }
          if (msg.data?.runnerConnected) {
            runnerConnectedRef.current = true;
            setRunnerConnected(true);
          }
          closeIfReady();
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      // Only set error if we haven't received a terminal status
      setError((prev) => prev ?? 'Connection lost');
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  return { status, runnerConnected, error };
}

// --- Time-ago helper ---

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// --- Language color map ---

const LANG_COLORS: Record<string, string> = {
  TypeScript: 'bg-blue-500',
  JavaScript: 'bg-yellow-400',
  Python: 'bg-green-500',
  Rust: 'bg-orange-600',
  Go: 'bg-cyan-500',
  Java: 'bg-red-500',
  Ruby: 'bg-red-600',
  Swift: 'bg-orange-500',
  Kotlin: 'bg-purple-500',
  C: 'bg-gray-500',
  'C++': 'bg-pink-500',
  'C#': 'bg-green-600',
  PHP: 'bg-indigo-400',
  Scala: 'bg-red-400',
  Shell: 'bg-emerald-500',
  HTML: 'bg-orange-400',
  CSS: 'bg-purple-400',
  Vue: 'bg-emerald-400',
  Dart: 'bg-blue-400',
};

// --- Main component ---

export function CreateSessionDialog({ trigger }: CreateSessionDialogProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<DialogView>('form');
  const navigate = useNavigate();
  const createSession = useCreateSession();

  // Form state
  const [workspace, setWorkspace] = useState('');
  const [repoMode, setRepoMode] = useState<RepoMode>('my-repos');
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [ref, setRef] = useState('');
  const [repoSearch, setRepoSearch] = useState('');
  const [workspaceManuallyEdited, setWorkspaceManuallyEdited] = useState(false);

  // PR/Issue selection state
  const [selectedPR, setSelectedPR] = useState<RepoPull | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<RepoIssue | null>(null);
  const [sourceType, setSourceType] = useState<SessionSourceType | undefined>(undefined);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>(undefined);

  // Persona state
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | undefined>(undefined);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelTouched, setModelTouched] = useState(false);

  // Progress state
  const [sessionResult, setSessionResult] = useState<CreateSessionResponse | null>(null);
  const [apiDone, setApiDone] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Queries
  const { data: reposData, isLoading: reposLoading } = useRepos();
  const { data: orgRepos } = useOrgRepos();
  const { data: personas } = usePersonas();
  const { data: availableModels } = useAvailableModels();
  const validateRepo = useValidateRepo(repoMode === 'url' ? repoUrl : '');

  // PR/Issue queries — derive owner/repo from selected repo
  const prIssueOwner = selectedRepo?.fullName?.split('/')[0] ?? '';
  const prIssueRepoName = selectedRepo?.fullName?.split('/')[1] ?? '';
  const { data: pullsData, isLoading: pullsLoading } = useRepoPulls(
    repoMode === 'from-pr' ? prIssueOwner : '',
    repoMode === 'from-pr' ? prIssueRepoName : ''
  );
  const { data: issuesData, isLoading: issuesLoading } = useRepoIssues(
    repoMode === 'from-issue' ? prIssueOwner : '',
    repoMode === 'from-issue' ? prIssueRepoName : ''
  );

  // WebSocket status tracking
  const { status: wsStatus, runnerConnected, error: wsError } = useSessionStatus(
    view === 'progress' ? sessionResult?.session.id ?? null : null
  );

  // Filtered repos
  const filteredRepos = useMemo(() => {
    if (!reposData?.repos) return [];
    if (!repoSearch.trim()) return reposData.repos;
    const q = repoSearch.toLowerCase();
    return reposData.repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false)
    );
  }, [reposData?.repos, repoSearch]);

  const selectedPersona = personas?.find((p) => p.id === selectedPersonaId);
  const personaDefaultModel = selectedPersona?.defaultModel;

  useEffect(() => {
    if (!modelTouched) {
      setSelectedModel('');
    }
  }, [selectedPersonaId, modelTouched]);

  // Elapsed time tracker for progress view
  useEffect(() => {
    if (view !== 'progress') {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [view]);

  // Auto-navigate when ready (both running and runner connected)
  useEffect(() => {
    if (wsStatus === 'running' && runnerConnected && sessionResult) {
      const timeout = setTimeout(() => {
        setOpen(false);
        navigate({ to: '/sessions/$sessionId', params: { sessionId: sessionResult.session.id } });
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [wsStatus, runnerConnected, sessionResult, navigate]);

  // Advance step index based on elapsed time when initializing
  const [timeBasedStep, setTimeBasedStep] = useState(1);
  useEffect(() => {
    if (view !== 'progress' || !apiDone || (wsStatus === 'running' && runnerConnected) || wsStatus === 'error') return;
    // Advance steps over time
    const hasRepo = !!selectedRepo || (repoMode === 'url' && !!repoUrl);
    if (elapsedSeconds >= 5 && hasRepo) setTimeBasedStep(2);
    if (elapsedSeconds >= 10) setTimeBasedStep(3);
  }, [elapsedSeconds, view, apiDone, wsStatus, selectedRepo, repoMode, repoUrl]);

  const resetDialog = useCallback(() => {
    setView('form');
    setWorkspace('');
    setSelectedRepo(null);
    setRepoUrl('');
    setBranch('');
    setRepoSearch('');
    setWorkspaceManuallyEdited(false);
    setSessionResult(null);
    setApiDone(false);
    setCreateError(null);
    setElapsedSeconds(0);
    setTimeBasedStep(1);
    setSelectedPR(null);
    setSelectedIssue(null);
    setSourceType(undefined);
    setInitialPrompt(undefined);
    setSelectedPersonaId(undefined);
    setSelectedModel('');
    setModelTouched(false);
    createSession.reset();
  }, [createSession]);

  const handleOpenChange = (v: boolean) => {
    if (!v && view === 'progress' && !(wsStatus === 'running' && runnerConnected) && wsStatus !== 'error') {
      // Don't allow closing during active progress
      return;
    }
    setOpen(v);
    if (!v) resetDialog();
  };

  const handleSelectRepo = (repo: Repo) => {
    setSelectedRepo(repo);
    if (!workspaceManuallyEdited) {
      setWorkspace(repo.name);
    }
    setBranch('');
    // Auto-select default persona for this repo if one exists
    const orgRepo = orgRepos?.find((r) => r.fullName === repo.fullName);
    if (orgRepo?.personaId) {
      setSelectedPersonaId(orgRepo.personaId);
    }
  };

  const handleClearRepo = () => {
    setSelectedRepo(null);
    if (!workspaceManuallyEdited) {
      setWorkspace('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace.trim()) return;

    setView('progress');
    setCreateError(null);
    setApiDone(false);

    // Build request
    const request: {
      workspace: string;
      repoUrl?: string;
      branch?: string;
      ref?: string;
      sourceType?: SessionSourceType;
      sourcePrNumber?: number;
      sourceIssueNumber?: number;
      sourceRepoFullName?: string;
      initialPrompt?: string;
      personaId?: string;
      initialModel?: string;
    } = {
      workspace: workspace.trim(),
    };

    if (selectedRepo) {
      request.repoUrl = selectedRepo.cloneUrl;
      if (branch.trim()) request.branch = branch.trim();
      if (ref.trim()) request.ref = ref.trim();
      request.sourceRepoFullName = selectedRepo.fullName;
    } else if (repoMode === 'url' && repoUrl.trim()) {
      request.repoUrl = repoUrl.trim();
      if (branch.trim()) request.branch = branch.trim();
      if (ref.trim()) request.ref = ref.trim();
    }

    if (sourceType) request.sourceType = sourceType;
    if (selectedPR) request.sourcePrNumber = selectedPR.number;
    if (selectedIssue) request.sourceIssueNumber = selectedIssue.number;
    if (initialPrompt) request.initialPrompt = initialPrompt;
    if (selectedPersonaId) request.personaId = selectedPersonaId;
    if (selectedModel) request.initialModel = selectedModel;

    try {
      const result = await createSession.mutateAsync(request);
      setSessionResult(result);
      setApiDone(true);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create session');
    }
  };

  const handleRetry = () => {
    setView('form');
    setCreateError(null);
    setApiDone(false);
    setSessionResult(null);
    setTimeBasedStep(1);
    createSession.reset();
  };

  const handleOpenSession = () => {
    if (!sessionResult) return;
    setOpen(false);
    navigate({ to: '/sessions/$sessionId', params: { sessionId: sessionResult.session.id } });
  };

  // Determine which step is active
  const hasRepo = !!selectedRepo || (repoMode === 'url' && !!repoUrl);
  const effectiveSteps = PROGRESS_STEPS.filter(
    (s) => hasRepo || s.key !== 'cloning'
  );

  let activeStepKey: string;
  if (createError || wsError) {
    activeStepKey = 'error';
  } else if (!apiDone) {
    activeStepKey = 'creating';
  } else if (wsStatus === 'running' && runnerConnected) {
    activeStepKey = 'ready';
  } else if (wsStatus === 'running' && !runnerConnected) {
    // Sandbox is running but runner hasn't connected yet
    activeStepKey = 'starting';
  } else {
    // Time-based progression
    const keys = effectiveSteps.map((s) => s.key);
    activeStepKey = keys[Math.min(timeBasedStep, keys.length - 2)] ?? 'spawning';
  }

  const repoUrlValid = validateRepo.data?.valid;
  const repoUrlError = validateRepo.data?.error;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? <Button>New Session</Button>}
      </DialogTrigger>
      <DialogContent className={cn('sm:max-w-lg', view === 'form' && 'sm:max-w-xl')}>
        {view === 'form' ? (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Create Session</DialogTitle>
              <DialogDescription>
                Start a new AI agent session. Optionally select a repository to clone.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Repository section */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Repository
                    <span className="ml-1 text-xs font-normal text-neutral-400">(optional)</span>
                  </label>
                  <div className="flex rounded-md border border-neutral-200 dark:border-neutral-700">
                    {(['my-repos', 'url', 'from-pr', 'from-issue'] as const).map((mode, i, arr) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => {
                          setRepoMode(mode);
                          if (mode === 'my-repos') { setRepoUrl(''); setSelectedPR(null); setSelectedIssue(null); setSourceType(undefined); setInitialPrompt(undefined); }
                          if (mode === 'url') { setSelectedRepo(null); setSelectedPR(null); setSelectedIssue(null); setSourceType(undefined); setInitialPrompt(undefined); }
                          if (mode === 'from-pr') { setRepoUrl(''); setSelectedPR(null); setSelectedIssue(null); setSourceType('pr'); setInitialPrompt(undefined); }
                          if (mode === 'from-issue') { setRepoUrl(''); setSelectedPR(null); setSelectedIssue(null); setSourceType('issue'); setInitialPrompt(undefined); }
                        }}
                        className={cn(
                          'px-2.5 py-1 text-xs font-medium transition-colors',
                          i === 0 && 'rounded-l-md',
                          i < arr.length - 1 && 'border-r border-neutral-200 dark:border-neutral-700',
                          i === arr.length - 1 && 'rounded-r-md',
                          repoMode === mode
                            ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                            : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                        )}
                      >
                        {mode === 'my-repos' ? 'My repos' : mode === 'url' ? 'URL' : mode === 'from-pr' ? 'From PR' : 'From Issue'}
                      </button>
                    ))}
                  </div>
                </div>

                {repoMode === 'my-repos' ? (
                  <div>
                    {selectedRepo ? (
                      <div className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700">
                        <div className="flex items-center gap-2">
                          {selectedRepo.language && (
                            <span
                              className={cn(
                                'h-2.5 w-2.5 rounded-full',
                                LANG_COLORS[selectedRepo.language] ?? 'bg-neutral-400'
                              )}
                            />
                          )}
                          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                            {selectedRepo.fullName}
                          </span>
                          {selectedRepo.private && (
                            <Badge variant="secondary">private</Badge>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={handleClearRepo}
                          className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <div>
                        <Input
                          value={repoSearch}
                          onChange={(e) => setRepoSearch(e.target.value)}
                          placeholder="Search repositories..."
                          className="mb-2"
                        />
                        <div className="max-h-48 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
                          {reposLoading ? (
                            <div className="flex items-center justify-center py-6">
                              <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
                            </div>
                          ) : filteredRepos.length === 0 ? (
                            <p className="py-4 text-center text-sm text-neutral-400">
                              {repoSearch ? 'No repos match your search' : 'No repositories found'}
                            </p>
                          ) : (
                            filteredRepos.map((repo) => (
                              <button
                                key={repo.id}
                                type="button"
                                onClick={() => handleSelectRepo(repo)}
                                className={cn(
                                  'flex w-full items-center justify-between px-3 py-2 text-left transition-colors',
                                  'hover:bg-neutral-50 dark:hover:bg-neutral-800/50',
                                  'border-b border-neutral-100 last:border-b-0 dark:border-neutral-800'
                                )}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    {repo.language && (
                                      <span
                                        className={cn(
                                          'h-2 w-2 flex-shrink-0 rounded-full',
                                          LANG_COLORS[repo.language] ?? 'bg-neutral-400'
                                        )}
                                      />
                                    )}
                                    <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                                      {repo.fullName}
                                    </span>
                                    {repo.private && (
                                      <Badge variant="secondary" className="flex-shrink-0">
                                        private
                                      </Badge>
                                    )}
                                  </div>
                                  {repo.description && (
                                    <p className="mt-0.5 truncate text-xs text-neutral-500">
                                      {repo.description}
                                    </p>
                                  )}
                                </div>
                                <div className="ml-3 flex flex-shrink-0 items-center gap-2">
                                  {repo.language && (
                                    <span className="text-xs text-neutral-400">
                                      {repo.language}
                                    </span>
                                  )}
                                  <span className="text-xs text-neutral-400">
                                    {timeAgo(repo.updatedAt)}
                                  </span>
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : repoMode === 'url' ? (
                  <div>
                    <div className="relative">
                      <Input
                        value={repoUrl}
                        onChange={(e) => setRepoUrl(e.target.value)}
                        placeholder="https://github.com/owner/repo"
                      />
                      {repoUrl && validateRepo.isFetching && (
                        <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
                        </div>
                      )}
                      {repoUrl && !validateRepo.isFetching && repoUrlValid === true && (
                        <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                          <CheckIcon className="h-4 w-4 text-emerald-500" />
                        </div>
                      )}
                      {repoUrl && !validateRepo.isFetching && repoUrlValid === false && (
                        <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                          <XIcon className="h-4 w-4 text-red-500" />
                        </div>
                      )}
                    </div>
                    {repoUrlError && (
                      <p className="mt-1 text-xs text-red-500">{repoUrlError}</p>
                    )}
                    {validateRepo.data?.repo && (
                      <p className="mt-1 text-xs text-neutral-500">
                        {validateRepo.data.repo.fullName} &middot; default branch: {validateRepo.data.repo.defaultBranch}
                      </p>
                    )}
                  </div>
                ) : repoMode === 'from-pr' ? (
                  <div>
                    {!selectedRepo ? (
                      <div>
                        <Input
                          value={repoSearch}
                          onChange={(e) => setRepoSearch(e.target.value)}
                          placeholder="Search repositories to select PRs from..."
                          className="mb-2"
                        />
                        <div className="max-h-36 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
                          {reposLoading ? (
                            <div className="flex items-center justify-center py-4">
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
                            </div>
                          ) : filteredRepos.length === 0 ? (
                            <p className="py-3 text-center text-sm text-neutral-400">No repos found</p>
                          ) : (
                            filteredRepos.map((repo) => (
                              <button
                                key={repo.id}
                                type="button"
                                onClick={() => handleSelectRepo(repo)}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800/50 border-b border-neutral-100 last:border-b-0 dark:border-neutral-800"
                              >
                                {repo.language && <span className={cn('h-2 w-2 rounded-full', LANG_COLORS[repo.language] ?? 'bg-neutral-400')} />}
                                <span className="truncate font-medium text-neutral-900 dark:text-neutral-100">{repo.fullName}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    ) : selectedPR ? (
                      <div className="rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-xs text-neutral-400">#{selectedPR.number}</span>
                            <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{selectedPR.title}</span>
                            {selectedPR.draft && <Badge variant="secondary">draft</Badge>}
                          </div>
                          <button type="button" onClick={() => { setSelectedPR(null); setBranch(''); setInitialPrompt(undefined); }} className="text-xs text-neutral-400 hover:text-neutral-600">Change</button>
                        </div>
                        <p className="mt-1 text-xs text-neutral-400">{selectedPR.headRef} &rarr; {selectedPR.baseRef}</p>
                      </div>
                    ) : (
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-xs text-neutral-500">{selectedRepo.fullName}</span>
                          <button type="button" onClick={handleClearRepo} className="text-xs text-neutral-400 hover:text-neutral-600">Change repo</button>
                        </div>
                        <div className="max-h-48 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
                          {pullsLoading ? (
                            <div className="flex items-center justify-center py-4">
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
                            </div>
                          ) : !pullsData?.length ? (
                            <p className="py-3 text-center text-sm text-neutral-400">No open pull requests</p>
                          ) : (
                            pullsData.map((pr) => (
                              <button
                                key={pr.number}
                                type="button"
                                onClick={() => {
                                  setSelectedPR(pr);
                                  setBranch(pr.headRef);
                                  if (!workspaceManuallyEdited) setWorkspace(selectedRepo!.name);
                                  setInitialPrompt(`Continue work on PR #${pr.number}: ${pr.title}${pr.body ? `\n\n${pr.body}` : ''}`);
                                }}
                                className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50 border-b border-neutral-100 last:border-b-0 dark:border-neutral-800"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs text-neutral-400">#{pr.number}</span>
                                    <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{pr.title}</span>
                                    {pr.draft && <Badge variant="secondary">draft</Badge>}
                                  </div>
                                  <p className="mt-0.5 text-xs text-neutral-400">{pr.headRef} &middot; {pr.author.login} &middot; {timeAgo(pr.updatedAt)}</p>
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  /* from-issue */
                  <div>
                    {!selectedRepo ? (
                      <div>
                        <Input
                          value={repoSearch}
                          onChange={(e) => setRepoSearch(e.target.value)}
                          placeholder="Search repositories to select issues from..."
                          className="mb-2"
                        />
                        <div className="max-h-36 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
                          {reposLoading ? (
                            <div className="flex items-center justify-center py-4">
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
                            </div>
                          ) : filteredRepos.length === 0 ? (
                            <p className="py-3 text-center text-sm text-neutral-400">No repos found</p>
                          ) : (
                            filteredRepos.map((repo) => (
                              <button
                                key={repo.id}
                                type="button"
                                onClick={() => handleSelectRepo(repo)}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800/50 border-b border-neutral-100 last:border-b-0 dark:border-neutral-800"
                              >
                                {repo.language && <span className={cn('h-2 w-2 rounded-full', LANG_COLORS[repo.language] ?? 'bg-neutral-400')} />}
                                <span className="truncate font-medium text-neutral-900 dark:text-neutral-100">{repo.fullName}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    ) : selectedIssue ? (
                      <div className="rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-xs text-neutral-400">#{selectedIssue.number}</span>
                            <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{selectedIssue.title}</span>
                          </div>
                          <button type="button" onClick={() => { setSelectedIssue(null); setInitialPrompt(undefined); }} className="text-xs text-neutral-400 hover:text-neutral-600">Change</button>
                        </div>
                        {selectedIssue.labels.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {selectedIssue.labels.map((l) => (
                              <span key={l.name} className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `#${l.color}20`, color: `#${l.color}` }}>
                                {l.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-xs text-neutral-500">{selectedRepo.fullName}</span>
                          <button type="button" onClick={handleClearRepo} className="text-xs text-neutral-400 hover:text-neutral-600">Change repo</button>
                        </div>
                        <div className="max-h-48 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
                          {issuesLoading ? (
                            <div className="flex items-center justify-center py-4">
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
                            </div>
                          ) : !issuesData?.length ? (
                            <p className="py-3 text-center text-sm text-neutral-400">No open issues</p>
                          ) : (
                            issuesData.map((issue) => (
                              <button
                                key={issue.number}
                                type="button"
                                onClick={() => {
                                  setSelectedIssue(issue);
                                  if (!workspaceManuallyEdited) setWorkspace(selectedRepo!.name);
                                  setInitialPrompt(`Work on issue #${issue.number}: ${issue.title}${issue.body ? `\n\n${issue.body}` : ''}`);
                                }}
                                className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50 border-b border-neutral-100 last:border-b-0 dark:border-neutral-800"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs text-neutral-400">#{issue.number}</span>
                                    <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{issue.title}</span>
                                  </div>
                                  <div className="mt-0.5 flex items-center gap-2">
                                    {issue.labels.slice(0, 3).map((l) => (
                                      <span key={l.name} className="inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `#${l.color}20`, color: `#${l.color}` }}>
                                        {l.name}
                                      </span>
                                    ))}
                                    <span className="text-xs text-neutral-400">{issue.author.login} &middot; {timeAgo(issue.updatedAt)}</span>
                                  </div>
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Branch input — shown when repo selected */}
              {(selectedRepo || (repoMode === 'url' && repoUrlValid)) && (
                <div>
                  <label
                    htmlFor="branch"
                    className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300"
                  >
                    Branch
                    <span className="ml-1 text-xs font-normal text-neutral-400">
                      {selectedPR ? '(required for PR)' : '(optional)'}
                    </span>
                  </label>
                  <Input
                    id="branch"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder={
                      selectedRepo
                        ? selectedRepo.defaultBranch
                        : validateRepo.data?.repo?.defaultBranch ?? 'main'
                    }
                  />
                  {selectedPR && (
                    <p className="mt-1 text-xs text-neutral-400">
                      Use the PR head branch.
                    </p>
                  )}
                </div>
              )}

              {(selectedRepo || (repoMode === 'url' && repoUrlValid)) && (
                <div>
                  <label
                    htmlFor="ref"
                    className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300"
                  >
                    Ref
                    <span className="ml-1 text-xs font-normal text-neutral-400">(optional)</span>
                  </label>
                  <Input
                    id="ref"
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    placeholder="Tag or commit SHA"
                  />
                  <p className="mt-1 text-xs text-neutral-400">
                    Tag or commit SHA. Takes precedence over branch.
                  </p>
                </div>
              )}

              {/* Persona picker */}
              <div>
                <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Agent Persona
                  <span className="ml-1 text-xs font-normal text-neutral-400">(optional)</span>
                </label>
                <PersonaPicker value={selectedPersonaId} onChange={setSelectedPersonaId} />
              </div>

              {/* Model picker */}
              <div>
                <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Model
                  <span className="ml-1 text-xs font-normal text-neutral-400">(optional)</span>
                </label>
                <select
                  value={selectedModel}
                  onChange={(e) => {
                    setSelectedModel(e.target.value);
                    setModelTouched(true);
                  }}
                  className="w-full cursor-pointer appearance-none rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                >
                  <option value="">
                    {personaDefaultModel
                      ? `Auto (persona default: ${personaDefaultModel})`
                      : 'Auto (session default)'}
                  </option>
                  {availableModels?.map((provider) => (
                    <optgroup key={provider.provider} label={provider.provider}>
                      {provider.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <p className="mt-1 text-xs text-neutral-400">
                  {personaDefaultModel
                    ? 'Leave as Auto to use the persona default model.'
                    : 'Leave as Auto to use the session default model.'}
                </p>
              </div>

              {/* Workspace input */}
              <div>
                <label
                  htmlFor="workspace"
                  className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-300"
                >
                  Workspace name
                </label>
                <Input
                  id="workspace"
                  value={workspace}
                  onChange={(e) => {
                    setWorkspace(e.target.value);
                    setWorkspaceManuallyEdited(true);
                  }}
                  placeholder="my-project"
                  autoFocus={!selectedRepo}
                />
              </div>

              {createSession.isError && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  Failed to create session. Please try again.
                </p>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!workspace.trim()}>
                Create
              </Button>
            </DialogFooter>
          </form>
        ) : (
          /* Progress view */
          <div>
            <DialogHeader>
              <DialogTitle>
                {createError || wsError ? 'Session Failed' : (wsStatus === 'running' && runnerConnected) ? 'Session Ready' : 'Starting Session'}
              </DialogTitle>
              <DialogDescription>
                {workspace}
                {hasRepo && (
                  <span className="ml-1 text-neutral-400">
                    &middot; {selectedRepo?.fullName ?? repoUrl}
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="py-6">
              {createError || wsError ? (
                <div className="flex flex-col items-center gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10">
                    <XIcon className="h-5 w-5 text-red-500" />
                  </div>
                  <p className="text-center text-sm text-red-600 dark:text-red-400">
                    {createError || wsError}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {effectiveSteps.map((step) => {
                    const isDone =
                      step.key === 'ready'
                        ? wsStatus === 'running' && runnerConnected
                        : effectiveSteps.findIndex((s) => s.key === step.key) <
                          effectiveSteps.findIndex((s) => s.key === activeStepKey);
                    const isActive = step.key === activeStepKey;

                    return (
                      <div
                        key={step.key}
                        className={cn(
                          'flex items-center gap-3 rounded-md px-3 py-2 transition-colors',
                          isActive && 'bg-neutral-50 dark:bg-neutral-800/50'
                        )}
                      >
                        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                          {isDone ? (
                            <CheckCircleIcon className="h-5 w-5 text-emerald-500" />
                          ) : isActive ? (
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600 dark:border-neutral-700 dark:border-t-neutral-300" />
                          ) : (
                            <div className="h-2 w-2 rounded-full bg-neutral-200 dark:bg-neutral-700" />
                          )}
                        </div>
                        <span
                          className={cn(
                            'text-sm',
                            isDone && 'text-neutral-500 dark:text-neutral-400',
                            isActive && 'font-medium text-neutral-900 dark:text-neutral-100',
                            !isDone && !isActive && 'text-neutral-400 dark:text-neutral-600'
                          )}
                        >
                          {step.label}
                          {step.key === 'cloning' && selectedRepo && (
                            <span className="ml-1 font-normal text-neutral-400">
                              ({selectedRepo.fullName})
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <DialogFooter>
              {createError || wsError ? (
                <div className="flex w-full gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setOpen(false);
                      resetDialog();
                    }}
                  >
                    Close
                  </Button>
                  <Button type="button" onClick={handleRetry}>
                    Try Again
                  </Button>
                </div>
              ) : (wsStatus === 'running' && runnerConnected) ? (
                <Button type="button" onClick={handleOpenSession}>
                  Open Session
                </Button>
              ) : (
                <div className="flex w-full items-center justify-between">
                  <p className="font-mono text-xs text-neutral-400">{elapsedSeconds}s</p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleOpenSession}
                    disabled={!sessionResult}
                  >
                    Open now
                  </Button>
                </div>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- Icons ---

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}
