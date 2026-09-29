import { WorkflowAgentApprovals } from "~/components/workflows/agent-approvals";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useSession } from "~/api/queries";
import { useAdoptWorkspaceScope } from "~/lib/workspace-scope";
import { SecuritySessionLayout } from "~/components/security/engagement-panel";
import { ChildPanel } from "~/components/session/child-panel";
import { SessionView } from "~/components/session/session-view";
import type { SandboxTabId } from "~/components/session/sandbox-tabs";

const TAB_VALUES: readonly string[] = ["chat", "browser", "terminal", "vscode"] satisfies SandboxTabId[];

export interface SessionSearch {
  /** Active thread id. Defaults to the first thread (engine's web:default). */
  thread?: string;
  /** Active view tab. Defaults to "chat" (Task 7 — Terminal/VS Code tabs). */
  tab?: SandboxTabId;
  /** Finding to preselect in the security panel — the Copy-permalink param
   * (valet-security design §Findings review). */
  finding?: string;
  /** Open child session id — renders `ChildPanel` as a slide-over, the same
   * as `/chat`, so a security cell's persona child opens in place instead of
   * navigating to its own standalone page. */
  child?: string;
}

export const Route = createFileRoute("/sessions/$sessionId")({
  validateSearch: (raw): SessionSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    tab:
      typeof raw.tab === "string" && TAB_VALUES.includes(raw.tab)
        ? (raw.tab as SandboxTabId)
        : undefined,
    finding: typeof raw.finding === "string" ? raw.finding : undefined,
    child: typeof raw.child === "string" ? raw.child : undefined,
  }),
  component: SessionPage,
});

function SessionPage() {
  const { sessionId } = Route.useParams();
  return sessionId.startsWith("wf:") ? <WorkflowAgentApprovals sessionId={sessionId} /> : <AppSessionPage />;
}

export function AppSessionPage() {
  const { sessionId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <SessionDetailPage sessionId={sessionId} search={search} onSearchChange={(update) => { void navigate({ search: update }); }} />;
}

export function SessionDetailPage({ sessionId, search, onSearchChange }: {
  sessionId: string;
  search: SessionSearch;
  onSearchChange: (update: (previous: SessionSearch) => SessionSearch) => void;
}) {
  const { thread, tab, finding, child: childPanelId } = search;
  const openChild = (childId: string) => onSearchChange((prev) => ({ ...prev, child: childId }));
  const closeChild = () => onSearchChange((prev) => ({ ...prev, child: undefined }));
  // Read the session kind: `kind === "security"` swaps in the engagement
  // panel layout. The query is shared with SessionView's own read, so this
  // adds no request.
  const session = useSession(sessionId);
  // Arriving from a notification or shared link for a team-owned session:
  // move the switcher to that session's workspace so the nav matches the
  // header (which badges the owning team) instead of leaving you in Personal.
  useAdoptWorkspaceScope(session.data?.owner);

  const workspace = session.data?.owner.type === "team" ? session.data.owner.id
    : session.data?.owner.type === "user" ? "user" : undefined;
  if (!session.error && session.data?.isWorkspaceRuntime) {
    return <Navigate to="/chat" replace search={{ workspace, thread, child: childPanelId }} />;
  }
  const parent = session.error ? undefined : session.data?.parentWork;

  const sessionView = (
    <SessionView
      sessionId={sessionId}
      activeThreadId={thread}
      activeTab={tab ?? "chat"}
      onTabChange={(next) => onSearchChange((prev) => ({ ...prev, tab: next }))}
    />
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {parent && <ChildBreadcrumb threadId={parent.threadId} />}
      {/* Standalone page (decision 14): no thread sidebar, full header —
          the root layout hides the sidebar for this route (see
          `__root.tsx`). Children opened full-page render the same way, with
          the breadcrumb above as their only visual distinction. */}
      {session.data?.kind === "security" ? (
        // Security sessions add the engagement panel beside the chat
        // (valet-security design §engagement panel); every other kind keeps
        // the layout exactly as it was.
        <SecuritySessionLayout
          sessionId={sessionId}
          initialFindingId={finding}
          chat={sessionView}
          onOpenChild={openChild}
        />
      ) : (
        sessionView
      )}
      {childPanelId && <ChildPanel childId={childPanelId} onClose={closeChild} />}
    </div>
  );
}

function ChildBreadcrumb({ threadId }: { threadId: string }) {
  return (
    <Link
      to="/threads/$threadId"
      params={{ threadId }}
      className="flex items-center gap-1.5 border-b border-line bg-neutral-50 px-4 py-2 text-xs text-muted hover:text-moss dark:bg-neutral-900/40"
    >
      <ArrowLeft className="h-3 w-3" aria-hidden />
      Back to originating thread
    </Link>
  );
}
