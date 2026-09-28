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
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { useAssistants } from "~/api/assistants";
import { ApiError } from "~/api/client";
import { useOrchestratorInfo } from "~/api/orchestrator";
import {
  useDeleteSession,
  usePauseSession,
  useRateSession,
  useRenameSession,
  useReplaceSandbox,
  useSessionRatings,
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
  DropdownMenuCheckboxItem,
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
import { formatElapsed, useElapsedSeconds } from "~/lib/use-elapsed";
import {
  queueBusy,
  useActiveModelForThread,
  useQueueStateForThread,
  type AgentStatus,
  type ConnectionStatus,
} from "~/stores/stream";
import { ModelPicker } from "./model-picker";
import { MoveSessionDialog } from "./move-session-dialog";
import { RatingButtons } from "./rating-buttons";
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
  turnStartedAt,
  conn,
  sandbox,
  threadId,
  messages,
}: {
  session: SessionDetail;
  agentStatus: AgentStatus;
  /** Wire timestamp the current turn began; undefined while idle. */
  turnStartedAt?: number;
  conn: ConnectionStatus;
  sandbox?: { state: string; epoch: number };
  threadId?: string;
  messages?: Message[];
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
  const ratings = useSessionRatings(session.id);
  const rateSession = useRateSession(session.id);
  const setProfile = useSetSessionProfile(session.id);
  const me = useMe();
  const org = useOrg();
  const orchInfo = useOrchestratorInfo();
  const teams = useTeams();
  const assistants = useAssistants();
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

  // Single-row masthead. The workspace path lives in a hover tooltip on
  // the title — for orchestrator sessions it's a long internal filesystem
  // path (`/root/.valet/orchestrator/user-…`) that shouted at users from
  // the subtitle before. Real sessions have friendlier workspace names,
  // but hiding both keeps the visual language consistent and lets the
  // action cluster on the right breathe.
  //
  // The orchestrator's title card carries the orchestrator's chosen name
  // (e.g. "Aurora") — the top-nav logo stays "Valet", so this is where
  // the assistant's identity lives.
  // The owning team comes from the assistants list rather than from the
  // session id: the id used to be parsed for it, which worked only while a
  // team had exactly one assistant. Narrowing still matters — `orchInfo` is
  // the viewer's OWN assistant, so a bare `startsWith("orchestrator:")` test
  // titled every team assistant with the viewer's personal assistant name.
  const assistant = assistants.data?.assistants.find((a) => a.sessionId === session.id);
  // The row's own `owner` covers standalone sessions, which have no
  // assistant entry: a team-owned standalone session must badge its team
  // and gate its admin controls exactly like a team assistant does.
  const owner = assistant?.owner ?? session.owner;
  const teamId = owner.type === "team" ? owner.id : null;
  const team = teamId !== null ? teams.data?.teams.find((t) => t.id === teamId) : undefined;
  // Your own assistant is recognised without waiting on the list:
  // `GET /orchestrator/info` answers with the very session id it names.
  const isOwnOrchestrator =
    assistant?.owner.type === "user" || orchInfo.data?.sessionId === session.id;
  const isAssistantSession = assistant !== undefined || isOwnOrchestrator;
  // `assistantLabel` is the SAME function the rail uses, so the row you
  // clicked and the header you land on cannot disagree. They did: an
  // assistant nobody has named showed as "Default assistant" in the rail and
  // as the owning TEAM's name here, which read as two different things.
  //
  // The team name is no longer a fallback for a nameless assistant. It named
  // the wrong entity — a team owns assistants, it is not one — and the badge
  // beside this title already says which team the conversation belongs to.
  const title = activeThread?.title || (isAssistantSession ? "New thread" : session.title || "Untitled thread");

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
  // Renaming writes `session.title`, so it is offered only where the header
  // actually shows that field. An assistant's header shows the assistant's
  // own name instead, which is renamed on the assistants surface — an edit
  // box here would store a string nobody ever sees.
  const canRename = canAdminister && !isAssistantSession;
  // A team's assistant is the one assistant kind this header may delete —
  // one name for the predicate the gate, the item label, and destroy()'s
  // prompt all share.
  const isTeamAssistant = isAssistantSession && teamId !== null;
  // Three descriptions for three losses. A team ASSISTANT is a shared
  // conversation, so the copy names what the team loses. A team-owned
  // STANDALONE session (reachable since "Move to workspace…") is still a
  // session — it keeps the sandbox/child-session warning and adds who else
  // loses it. A personal session keeps the original warning. The user's own
  // assistant never reaches here: `canDelete` hides the menu item
  // (TKAI-253).
  const teamNote = `Everyone on ${team?.name ?? "the team"} loses`;
  const deleteTitle = isTeamAssistant ? `Delete ${title}?` : "Delete this session permanently?";
  const deleteDescription = isTeamAssistant
    ? `${teamNote} this conversation and its threads.`
    : teamId !== null
      ? `${teamNote} it. This deletes all threads, history, and child sessions, and tears down the sandbox.`
      : "This deletes all threads, history, and child sessions, and tears down the sandbox.";
  // Delete never renders on the user's own assistant page (TKAI-253): the
  // v1 holdover deleted the orchestrator and every thread with it, and
  // Replace sandbox covers the reset. Fail closed while the assistants
  // list or the orchestrator probe is still loading — in that window every
  // session looks like a plain session, and the one destructive action
  // here must not flash on an assistant page. The API refuses these
  // deletes too; hiding the item keeps the menu honest.
  const canDelete =
    canAdminister &&
    assistants.data !== undefined &&
    orchInfo.data !== undefined &&
    (!isAssistantSession || isTeamAssistant);

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
          <SandboxChip sandbox={sandbox} />
          <ConnectionBadge conn={conn} />
          <AgentStatusBadge status={agentStatus} turnStartedAt={turnStartedAt} queueBusy={threadBusy} />
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
          {/* Names the owning team, now that the title does not.

              This badge used to read the bare word "Team", because the title
              was the team's name and "Platform [Platform]" says one thing
              twice. The title is the assistant's own label now — the same
              label the rail shows — so the team name would otherwise appear
              nowhere in this row, and "Team" alone cannot answer WHICH team
              a person with several is reading.

              Still not `OwnerBadge`: that one links to the team's assistant,
              which is the page you are already on. */}
          {teamId !== null && (
            // The test hook lets a test assert THIS element rather than the
            // team's name appearing anywhere in the header, which a title
            // regression could satisfy on its own.
            <Badge variant="accent" className="hidden sm:inline-flex max-w-full truncate" data-testid="owning-team">
              {team?.name ?? "Team"}
            </Badge>
          )}
          {/* An orchestrator's workspace is a synthetic internal directory
              (`~/.valet/orchestrator/{type}-{principalId}`), not a place
              anyone chose or can act on. On a team assistant it rendered as
              `team-team_99235d43-…` — the doubled prefix is the principal
              type joined to an id that already carries it — which is an
              internal identifier shown to a user for no reason. The file's
              own note above says these paths "shouted at users from the
              subtitle"; this is that intent, finally applied to the chip.

              No `uppercase` on the chip when it does render — real
              workspace names are case-sensitive paths, and shouting them in
              caps misrepresents them. */}
          {session.workspace && !isAssistantSession && (
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
          <SandboxChip sandbox={sandbox} />
          <ConnectionBadge conn={conn} />
          <AgentStatusBadge status={agentStatus} turnStartedAt={turnStartedAt} queueBusy={threadBusy} />
          <RatingButtons
            subject="session"
            value={ratings.data?.session ?? null}
            disabled={rateSession.isPending}
            onRate={(rating) => rateSession.mutate(rating)}
          />
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
                <SandboxChip sandbox={sandbox} />
                <ConnectionBadge conn={conn} />
                <AgentStatusBadge status={agentStatus} turnStartedAt={turnStartedAt} queueBusy={threadBusy} />
              </div>
              <DropdownMenuCheckboxItem
                checked={ratings.data?.session === "positive"}
                disabled={rateSession.isPending}
                onCheckedChange={(checked) => rateSession.mutate(checked ? "positive" : null)}
              >
                <ThumbsUp className="h-4 w-4" aria-hidden />Good session
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={ratings.data?.session === "negative"}
                disabled={rateSession.isPending}
                onCheckedChange={(checked) => rateSession.mutate(checked ? "negative" : null)}
              >
                <ThumbsDown className="h-4 w-4" aria-hidden />Bad session
              </DropdownMenuCheckboxItem>
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
                {/* Standalone sessions only: an assistant's session is
                    addressed by its owner, so its owner is structural (the
                    API refuses too). Gated on the assistants list having
                    RESOLVED — while it loads, `isAssistantSession` is false
                    for every session, and the item would flash on assistant
                    pages. */}
                {!isAssistantSession && assistants.data !== undefined && (
                  <DropdownMenuItem onSelect={() => setMoving(true)}>
                    <FolderInput className="h-3.5 w-3.5 mr-2" aria-hidden />
                    Move to workspace…
                  </DropdownMenuItem>
                )}
                {/* Never on the user's own assistant page — see `canDelete`.
                    A team admin keeps delete for the team's assistant. Note
                    the item deletes the assistant's SESSION (threads and
                    history); the assistant row itself is archived on the
                    assistants surface. */}
                {canDelete && (
                  <DropdownMenuItem
                    className="text-danger-500"
                    disabled={del.isPending}
                    onSelect={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" aria-hidden />
                    {/* Only an assistant session IS the team's assistant. A
                        team-owned standalone session is a session; calling it
                        the assistant would threaten the wrong thing. */}
                    {isTeamAssistant ? "Delete this team's assistant…" : "Delete session…"}
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
        confirmLabel={isTeamAssistant ? "Delete assistant" : "Delete session"}
        pendingLabel="Deleting…"
        pending={del.isPending}
        error={deleteError ?? undefined}
        onConfirm={() => void destroy()}
      />
    </header>
  );
}

function ConnectionBadge({ conn }: { conn: ConnectionStatus }) {
  const map: Record<ConnectionStatus, { label: string; variant: "neutral" | "success" | "danger" }> = {
    idle: { label: "idle", variant: "neutral" },
    connecting: { label: "connecting", variant: "neutral" },
    open: { label: "live", variant: "success" },
    closed: { label: "offline", variant: "neutral" },
    error: { label: "error", variant: "danger" },
  };
  const { label, variant } = map[conn];
  return <Badge variant={variant}>{label}</Badge>;
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

function AgentStatusBadge({
  status,
  turnStartedAt,
  queueBusy = false,
}: {
  status: AgentStatus;
  turnStartedAt?: number;
  /**
   * Durable fallback: the thread's queue holds an abortable submission. When
   * the live `status` still reads idle (mid-turn connect before the seed
   * frame, or a dropped event), the badge shows a generic "working" instead
   * of a false "idle".
   */
  queueBusy?: boolean;
}) {
  const busy = status !== "idle" || queueBusy;
  const elapsed = useElapsedSeconds(busy ? turnStartedAt : undefined);
  if (!busy) return <Badge variant="neutral">idle</Badge>;
  // replaceAll, not replace: "blocked_on_decision_gate" has four segments
  // and a single replace rendered "blocked on_decision_gate".
  const label = status === "idle" ? "working" : status.replaceAll("_", " ");
  // "queued" and "blocked_on_decision_gate" stay neutral on purpose (the
  // pre-fallback behavior): nothing is executing while queued, and a
  // gate-blocked turn already renders the prominent DecisionGateCard — an
  // accent badge would signal the same thing twice. "idle" here is the
  // queue-busy fallback (`busy` gate above), so it reads as active work.
  const variant =
    status === "error"
      ? "danger"
      : status === "thinking" || status === "tool_calling" || status === "idle"
        ? "accent"
        : "neutral";
  return (
    <Badge variant={variant} className={cn("inline-flex items-center gap-1.5 tabular-nums")}>
      {status !== "queued" && (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
      )}
      {label}
      {elapsed !== undefined && <span className="text-current/70">{formatElapsed(elapsed)}</span>}
    </Badge>
  );
}
