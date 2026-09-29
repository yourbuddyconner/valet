import { useNavigate } from "@tanstack/react-router";
import type { Message, SessionDetail } from "@valet/api/wire";
import {
  Check,
  ClipboardCopy,
  FolderInput,
  Moon,
  MoreHorizontal,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { ApiError } from "~/api/client";
import {
  useDeleteSession,
  usePauseSession,
  useRenameSession,
  useReplaceSandbox,
  useSetSessionModel,
  useSetSessionProfile,
  useSetSessionReasoning,
  useSetThreadModel,
  useSetThreadReasoning,
  useThreads,
} from "~/api/queries";
import { useMe, useOrg, useTeams } from "~/api/settings";
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Spinner,
  Tooltip,
} from "~/components/primitives";
import { useResponsiveOverlay } from "~/hooks/use-responsive-overlay";
import { cn } from "~/lib/cn";
import { sameModelSpec } from "~/lib/models";
import { useCopyToClipboard } from "~/lib/use-copy";
import {
  queueBusy,
  useActiveModelForThread,
  usePendingGateForThread,
  useQueueStateForThread,
  type AgentStatus,
  type ConnectionStatus,
} from "~/stores/stream";
import { ModelPicker } from "./model-picker";
import { MoveSessionDialog } from "./move-session-dialog";
import { ThreadStatusIcon } from "./thread-status-icon";
import { buildTranscript } from "./transcript";

/** Collapse a workspace path down to a header-friendly badge: any
 * multi-segment path shows only its LAST segment ("ws-19",
 * "my-repo"), except orchestrator-style paths whose last segment is an
 * opaque id ("user-1fony…") — those show the second-to-last segment
 * ("orchestrator") instead. Single-word workspaces pass through. The
 * full path stays discoverable via the header tooltip. */
export function shortenWorkspace(workspace: string): string {
  const parts = workspace.split("/").filter((p) => p.length > 0);
  if (parts.length <= 1) return workspace;
  const lastIsUuidLike = /^(user-|orch-|wf|s_|wfrun_)/.test(parts[parts.length - 1] ?? "");
  return lastIsUuidLike
    ? parts[parts.length - 2] ?? parts[parts.length - 1] ?? workspace
    : parts[parts.length - 1] ?? workspace;
}

/** Server sends `{ error: "a turn is running" }` / `{ error: "sandbox is not
 * ready to pause" }` for the documented 409s (pause and sandbox-replace);
 * fall back to the mutation's own message for anything else (network
 * failure, capability-off 409, unexpected shape). */
function extractActionError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return err instanceof Error ? err.message : fallback;
}

export function SessionHeader({
  session,
  agentStatus,
  conn,
  sandbox,
  threadId,
  messages,
  summaryControl,
}: {
  session: SessionDetail;
  agentStatus: AgentStatus;
  /** Wire timestamp the current turn began; undefined while idle. */
  turnStartedAt?: number;
  conn: ConnectionStatus;
  sandbox?: { state: string; epoch: number };
  threadId?: string;
  messages?: Message[];
  summaryControl?: ReactNode;
}) {
  const navigate = useNavigate();
  const sessionMenu = useResponsiveOverlay("sm");
  const del = useDeleteSession();
  const setModel = useSetSessionModel(session.id);
  const setThreadModel = useSetThreadModel(session.id);
  const setReasoning = useSetSessionReasoning(session.id);
  const setThreadReasoning = useSetThreadReasoning(session.id);
  // The picker is thread-scoped (threads pin their model at creation —
  // TKAI-201): it shows and PATCHes the ACTIVE THREAD's model. Legacy
  // threads without a pin display, and keep tracking, the session default.
  //
  // With a threadId in hand the picker NEVER falls back to the session
  // PATCH: while the threads query is loading (or the id names an archived
  // thread) a session-default write would silently not affect the pinned
  // active thread — the exact wrong-scope switch pinning exists to prevent.
  // The picker disables until the thread row resolves instead.
  const threads = useThreads(session.id);
  const activeThread = threads.data?.threads.find((t) => t.id === threadId);
  const threadScoped = threadId !== undefined;
  const modelConfigurationResolved = !threadScoped || activeThread !== undefined;
  const configuredModel = activeThread ? (activeThread.model ?? session.model) : session.model;
  const configuredReasoning = activeThread
    ? (activeThread.reasoning ?? session.reasoning)
    : session.reasoning;
  const activeModel = useActiveModelForThread(session.id, threadId);
  const pickerDisabled = threadScoped
    ? !activeThread || setThreadModel.isPending
    : setModel.isPending;
  const pause = usePauseSession(session.id);
  const replace = useReplaceSandbox(session.id);
  const rename = useRenameSession(session.id);
  const setProfile = useSetSessionProfile(session.id);
  const me = useMe();
  const org = useOrg();
  const teams = useTeams();
  // One error slot for the header actions that fire straight from their
  // control: pause, replace, and rename. Delete and the Terminal/VS Code
  // switch confirm first, and their modal covers this row, so each reports
  // its own failure inside its dialog.
  const [actionError, setActionError] = useState<string | null>(null);
  // Delete and the Terminal/VS Code switch confirm in a `ConfirmDialog`, not
  // in `window.confirm`: the native prompt shows no pending state, drops the
  // server's refusal, and browser automation accepts it before a person sees
  // it. A header describes ONE session, so one boolean each is enough — no
  // second row can open the same dialog.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmServices, setConfirmServices] = useState(false);
  const [servicesError, setServicesError] = useState<string | null>(null);
  // Durable busy fallback for the status badge — same signal the composer's
  // Stop/Escape affordance uses. Without it, a page that connects mid-turn
  // shows "idle" next to a visible Stop button until the next status event.
  const pendingGate = usePendingGateForThread(session.id, threadId);
  const threadBusy = queueBusy(useQueueStateForThread(session.id, threadId));
  const { copied, copy: copyToClipboard } = useCopyToClipboard();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [moving, setMoving] = useState(false);
  // Enter and blur both reach `commitRename`, and Enter unmounts the input,
  // which fires blur straight after. The ref makes the commit idempotent so
  // one edit sends one PATCH.
  const editOpen = useRef(false);

  // Runs from the delete dialog's confirm button, never from the menu item:
  // the menu only opens the dialog. On success the dialog closes before the
  // route changes; on failure it stays open and shows why.
  async function destroy() {
    setDeleteError(null);
    try {
      await del.mutateAsync(session.id);
      setConfirmDelete(false);
      navigate({ to: "/" });
    } catch (err) {
      setDeleteError(extractActionError(err, "Failed to delete the session. Try again."));
    }
  }

  async function pauseSession() {
    setActionError(null);
    try {
      await pause.mutateAsync();
    } catch (err) {
      setActionError(extractActionError(err, "Failed to pause session."));
    }
  }

  async function replaceSandbox() {
    setActionError(null);
    try {
      await replace.mutateAsync();
    } catch (err) {
      setActionError(extractActionError(err, "Failed to replace the sandbox."));
    }
  }

  // The profile decides whether the sandbox starts a terminal server and a
  // VS Code server. It is baked into the container at create time, so the
  // switch restarts the sandbox. Name that cost before doing it — the
  // workspace files survive, an open terminal does not.
  const turningOnServices = session.profile !== "full";

  async function applyInteractiveServices() {
    setServicesError(null);
    try {
      await setProfile.mutateAsync(turningOnServices ? "full" : "headless");
      setConfirmServices(false);
    } catch (err) {
      setServicesError(
        extractActionError(err, "Failed to change the session's services. Try again."),
      );
    }
  }

  function beginRename() {
    setActionError(null);
    setTitleDraft(session.title ?? "");
    editOpen.current = true;
    setEditingTitle(true);
  }

  function cancelRename() {
    editOpen.current = false;
    setEditingTitle(false);
  }

  async function commitRename() {
    if (!editOpen.current) return;
    editOpen.current = false;
    setEditingTitle(false);
    const next = titleDraft.trim();
    // An empty box and an unchanged name both mean "leave it alone". The
    // server rejects an empty title, so do not send one.
    if (next.length === 0 || next === (session.title ?? "")) return;
    setActionError(null);
    try {
      await rename.mutateAsync(next);
    } catch (err) {
      setActionError(extractActionError(err, "Failed to rename the session. Try again."));
    }
  }

  async function copyTranscript() {
    const transcript = buildTranscript({
      session,
      threadId,
      messages: messages ?? [],
      agentStatus,
      conn,
      sandbox,
      user: me.data
        ? { id: me.data.id, email: me.data.email, name: me.data.name }
        : undefined,
      org: me.data
        ? { id: me.data.orgId, name: org.data?.name ?? null }
        : undefined,
      env: {
        origin: typeof window !== "undefined" ? window.location.origin : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      },
    });
    const ok = await copyToClipboard(transcript);
    if (!ok) console.error("copy transcript failed");
  }

  const owner = session.owner;
  const teamId = owner.type === "team" ? owner.id : null;
  const team = teamId !== null ? teams.data?.teams.find((t) => t.id === teamId) : undefined;
  const isWorkspaceRuntime = session.isWorkspaceRuntime === true;
  const title = activeThread?.title || (isWorkspaceRuntime ? "New thread" : session.title || "Untitled thread");

  // Lifecycle controls (model, pause, delete) act on a session the whole
  // team shares, so they are a team-admin power — the API enforces the
  // same rule; this only hides controls that would 404. Personal sessions
  // are unaffected.
  const canAdminister =
    teamId === null || team?.callerRole === "admin" || me.data?.orgRole === "admin";
  const workspaceHint = session.workspace ? `workspace: ${session.workspace}` : title;
  const modelScopeHint = threadScoped
    ? "Model for this thread (pinned at creation). New threads use the workspace default."
    : "Session-default model. New threads pin it at creation.";
  const modelHint =
    modelConfigurationResolved &&
    activeModel &&
    configuredModel &&
    !sameModelSpec(activeModel, configuredModel)
      ? `${modelScopeHint} Currently using ${activeModel} for this submission. Configured as ${configuredModel}.`
      : modelScopeHint;
  // Runtime titles belong to threads. Standalone titles belong to the session.
  const canRename = canAdminister && session.isWorkspaceRuntime === false;
  const deleteTitle = "Delete this session permanently?";
  const deleteDescription = `${teamId !== null ? `Everyone on ${team?.name ?? "the team"} loses it. ` : ""}This deletes all threads, history, and child sessions, and tears down the sandbox.`;
  // Fail closed until the detail response identifies the runtime boundary.
  const canDelete = canAdminister && session.isWorkspaceRuntime === false;

  // The edit box replaces the title cluster. The right-hand side keeps the
  // read-only signals — sandbox, connection, agent status — and the error
  // slot, so the row does not jump and a failed rename still has somewhere
  // to report. The action buttons are dropped while editing: they act on a
  // session the person is in the middle of naming.
  if (editingTitle) {
    return (
      <header className="border-b border-line bg-paper px-3 py-2 min-h-[--nav-height] shrink-0 flex flex-wrap items-center gap-2 sm:px-4 sm:gap-3">
        <form
          className="min-w-0 max-w-full flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void commitRename();
          }}
        >
          <Input
            autoFocus
            aria-label="Session title"
            className="w-full sm:h-7 sm:w-64 sm:max-w-full font-semibold"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
          />
        </form>
        <span className="text-xs text-muted shrink-0 hidden sm:inline">
          Enter to save, Esc to cancel
        </span>
        <div className="ml-auto hidden max-w-full flex-wrap items-center gap-1.5 sm:flex">
          {actionError && <span className="text-xs text-danger-500">{actionError}</span>}
          <ThreadStatusIcon status={agentStatus} busy={threadBusy} needsApproval={Boolean(pendingGate)} conn={conn} />
        </div>
      </header>
    );
  }

  return (
    <header className="border-b border-line bg-paper px-3 py-1 min-h-[--nav-height] shrink-0 flex min-w-0 flex-wrap items-center gap-1 sm:px-4 sm:py-2 sm:gap-3">
      <Tooltip content={workspaceHint} delayDuration={400}>
        <div className="min-w-0 flex-1 sm:flex-initial max-w-full flex flex-wrap items-baseline gap-2 cursor-default">
          {canRename ? (
            <button
              type="button"
              onClick={beginRename}
              aria-label={`Rename session: ${title}`}
              className="max-sm:min-h-11 max-sm:text-left text-sm font-semibold tracking-tight truncate text-ink font-display rounded px-0.5 -mx-0.5 hover:bg-ink-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
            >
              {rename.isPending ? <Spinner size={14} /> : title}
            </button>
          ) : (
            <span className="text-sm font-semibold tracking-tight truncate text-ink font-display">
              {title}
            </span>
          )}
          {/* The owner badge names the workspace beside the thread title. */}
          {teamId !== null && (
            // The test hook lets a test assert THIS element rather than the
            // team's name appearing anywhere in the header, which a title
            // regression could satisfy on its own.
            <Badge variant="accent" className="hidden sm:inline-flex max-w-full truncate" data-testid="owning-team">
              {team?.name ?? "Team"}
            </Badge>
          )}
          {/* Runtime workspace paths are internal; standalone paths describe the work. */}
          {session.workspace && !isWorkspaceRuntime && (
            <span className="hidden sm:inline text-[10px] font-mono tracking-wide text-muted truncate">
              {shortenWorkspace(session.workspace)}
            </span>
          )}
        </div>
      </Tooltip>
      <div className="ml-auto flex min-w-0 max-w-56 shrink-0 items-center gap-1 sm:max-w-full sm:flex-wrap sm:gap-1.5">
        {canAdminister && (
          <Tooltip content={modelHint}>
            <span className="min-w-0">
              <ModelPicker
                currentId={configuredModel}
                displayId={activeModel ?? configuredModel}
                ariaDescription={modelHint}
                onSelect={(id) => {
                  if (threadScoped) {
                    // Disabled until activeThread resolves; the guard is
                    // belt-and-braces against a race on the same render.
                    if (activeThread) {
                      setThreadModel.mutate({ threadId: activeThread.id, model: id });
                    }
                    return;
                  }
                  setModel.mutate(id);
                }}
                currentReasoning={
                  modelConfigurationResolved ? (configuredReasoning ?? undefined) : undefined
                }
                onSelectReasoning={(level) => {
                  if (threadScoped) {
                    if (activeThread) {
                      setThreadReasoning.mutate({ threadId: activeThread.id, reasoning: level });
                    }
                    return;
                  }
                  setReasoning.mutate(level);
                }}
                disabled={pickerDisabled}
              />
            </span>
          </Tooltip>
        )}
        <div className="hidden sm:contents">
          <ThreadStatusIcon status={agentStatus} busy={threadBusy} needsApproval={Boolean(pendingGate)} conn={conn} />
          <Tooltip content={copied ? "Copied to clipboard" : "Copy debug transcript (session/thread + raw tool calls + env)"}>
            <Button
              variant="ghost"
              size="sm"
              onClick={copyTranscript}
              aria-label="Copy transcript"
            >
              {copied ? (
                <Check className="h-4 w-4 text-moss" />
              ) : (
                <ClipboardCopy className="h-4 w-4" />
              )}
            </Button>
          </Tooltip>
        </div>
        {canAdminister && (
          <Tooltip content="Pause session — sandbox sleeps until the next message">
            <Button
              variant="ghost"
              size="sm"
              onClick={pauseSession}
              disabled={sandbox?.state !== "ready" || pause.isPending}
              className="hidden sm:inline-flex"
              aria-label="Pause session"
            >
              {pause.isPending ? <Spinner size={14} /> : <Moon className="h-4 w-4" />}
            </Button>
          </Tooltip>
        )}
        <DropdownMenu open={sessionMenu.open} onOpenChange={sessionMenu.setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={cn("shrink-0", !canAdminister && "sm:hidden")} aria-label="Thread menu">
              {del.isPending || replace.isPending || setProfile.isPending ? (
                <Spinner size={14} />
              ) : (
                <MoreHorizontal className="h-4 w-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <div className="sm:hidden">
              <DropdownMenuLabel className="max-w-64 break-words">
                {title}{teamId !== null ? ` · ${team?.name ?? "Team"}` : ""}
              </DropdownMenuLabel>
              <div className="flex max-w-64 flex-wrap items-center gap-2 px-2 py-1.5">
                <ThreadStatusIcon status={agentStatus} busy={threadBusy} needsApproval={Boolean(pendingGate)} conn={conn} />
              </div>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  void copyTranscript();
                }}
              >
                <ClipboardCopy className="h-4 w-4" aria-hidden />{copied ? "Transcript copied" : "Copy transcript"}
              </DropdownMenuItem>
              {canAdminister && (
                <DropdownMenuItem
                  disabled={sandbox?.state !== "ready" || pause.isPending}
                  onSelect={() => void pauseSession()}
                >
                  <Moon className="h-4 w-4" aria-hidden />
                  {pause.isPending ? "Pausing…" : "Pause session"}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </div>
            {canAdminister && (
              <>
                <DropdownMenuItem
                  disabled={setProfile.isPending}
                  onSelect={() => setConfirmServices(true)}
                >
                  <SquareTerminal className="h-3.5 w-3.5 mr-2" aria-hidden />
                  {session.profile === "full"
                    ? "Turn off Terminal and VS Code…"
                    : "Turn on Terminal and VS Code…"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={replace.isPending}
                  onSelect={() => void replaceSandbox()}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-2" aria-hidden />
                  Replace sandbox
                </DropdownMenuItem>
                {/* Workspace runtime ownership is structural. */}
                {session.isWorkspaceRuntime === false && (
                  <DropdownMenuItem onSelect={() => setMoving(true)}>
                    <FolderInput className="h-3.5 w-3.5 mr-2" aria-hidden />
                    Move to workspace…
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    className="text-danger-500"
                    disabled={del.isPending}
                    onSelect={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" aria-hidden />
                    Delete session…
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {summaryControl}
      </div>
      {actionError && <p role="alert" className="basis-full min-w-0 break-words text-xs text-danger-500">{actionError}</p>}
      {moving && (
        <MoveSessionDialog
          sessionId={session.id}
          owner={owner}
          open={moving}
          onOpenChange={setMoving}
        />
      )}
      {/* Both dialogs stay mounted so a failure can report inside the one
          the person is looking at. Closing either clears its stale error, so
          a second attempt does not open on the last refusal. */}
      <ConfirmDialog
        open={confirmServices}
        onOpenChange={(open) => {
          setConfirmServices(open);
          if (!open) setServicesError(null);
        }}
        title={
          turningOnServices ? "Turn on Terminal and VS Code?" : "Turn off Terminal and VS Code?"
        }
        description="The workspace sandbox restarts now. Your files are kept. Anything open in a terminal is lost."
        confirmLabel={turningOnServices ? "Turn on" : "Turn off"}
        pendingLabel={turningOnServices ? "Turning on…" : "Turning off…"}
        pending={setProfile.isPending}
        error={servicesError ?? undefined}
        onConfirm={() => void applyInteractiveServices()}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          setConfirmDelete(open);
          if (!open) setDeleteError(null);
        }}
        title={deleteTitle}
        description={deleteDescription}
        confirmLabel="Delete session"
        pendingLabel="Deleting…"
        pending={del.isPending}
        error={deleteError ?? undefined}
        onConfirm={() => void destroy()}
      />
    </header>
  );
}

/**
 * Ambient workspace-sandbox indicator: a dot + short label, not a full
 * `Badge` — this is a background signal, not something the user acts on.
 * Renders nothing until the first `sandbox.status` frame arrives (absent =
 * unknown, not "detached") to avoid layout shift / a misleading state.
 */
export function SandboxChip({ sandbox }: { sandbox?: { state: string; epoch: number } }) {
  if (!sandbox) return null;
  const map: Record<string, { dot: string; label: string }> = {
    provisioning: { dot: "bg-amber-500", label: "workspace provisioning…" },
    ready: { dot: "bg-success-500", label: "workspace ready" },
    idle: { dot: "bg-success-500", label: "workspace idle" },
    snapshotting: { dot: "bg-amber-500", label: "workspace snapshotting…" },
    suspended: { dot: "bg-neutral-400", label: "sleeping — will wake on message" },
    released: { dot: "bg-neutral-400", label: "workspace released" },
    error: { dot: "bg-danger-500", label: "workspace error" },
  };
  const entry = map[sandbox.state];
  if (!entry) return null;
  return (
    <Tooltip content={entry.label}>
      <span className="inline-flex items-center gap-1.5 px-1" aria-label={entry.label}>
        <span className={cn("h-1.5 w-1.5 rounded-full", entry.dot)} />
      </span>
    </Tooltip>
  );
}
