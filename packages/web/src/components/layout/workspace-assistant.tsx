import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles, X, ExternalLink } from "lucide-react";
import { qk } from "~/api/queries";
import { api } from "~/api/client";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { SessionView } from "~/components/session/session-view";
import { prefillComposerDraft } from "~/stores/composer-drafts";
import { Button } from "~/components/primitives";

type Conversation = { sessionId: string; threadId: string };
type Assistant = { open: (prompt?: string) => void; panel: ReactNode; close: () => void; isOpen: boolean };
const Context = createContext<Assistant | null>(null);
export function useWorkspaceAssistant() {
  const context = useContext(Context);
  if (!context) throw new Error("Workspace assistant provider is missing");
  return context;
}

/** One durable workspace Thread, reused across app pages. No helper sessions. */
export function WorkspaceAssistantProvider({ children }: { children: ReactNode }) {
  const scope = useWorkspaceScope();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  const conversations = useRef(new Map<string, Promise<Conversation>>());
  const [opened, setOpened] = useState<string>();
  const [loaded, setLoaded] = useState<Record<string, Conversation>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const workspace = scope.key;
  const requestGeneration = useRef(0);
  const activePath = useRef(pathname);
  activePath.current = pathname;
  const activeWorkspace = useRef(workspace);
  activeWorkspace.current = workspace;
  function close() { requestGeneration.current += 1; setOpened(undefined); }
  async function open(prompt?: string) {
    const generation = ++requestGeneration.current;
    const mayNavigate = () => generation === requestGeneration.current && activeWorkspace.current === workspace && activePath.current === pathname;
    setOpened(workspace);
    setErrors((current) => ({ ...current, [workspace]: "" }));
    const workflowMatch = /^\/workflows\/([^/]+)$/.exec(pathname);
    if (workflowMatch) {
      try {
        const conversation = await api.ensureWorkflowConversation(decodeURIComponent(workflowMatch[1]!));
        const session = await api.getSession(conversation.sessionId);
        const ownerWorkspace = session.owner.type === "team" ? session.owner.id : "user";
        if (mayNavigate()) {
          setOpened(undefined);
          await navigate({ to: "/chat", search: { workspace: ownerWorkspace, thread: conversation.threadId } });
        }
      } catch (error) {
        setErrors((current) => ({ ...current, [workspace]: error instanceof Error ? error.message : "Could not open the workflow Thread." }));
      }
      return;
    }
    let pending = conversations.current.get(workspace);
    if (!pending) {
      pending = (async () => {
        const conversation = await api.ensureWorkspaceConversation(workspace);
        await qc.invalidateQueries({ queryKey: qk.threads(conversation.sessionId) });
        return conversation;
      })();
      conversations.current.set(workspace, pending);
    }
    try {
      const conversation = await pending;
      if (prompt) prefillComposerDraft(conversation.sessionId, conversation.threadId, prompt);
      setLoaded((current) => ({ ...current, [workspace]: conversation }));
      // Chat already owns a composer: navigate to this Thread instead of mounting a second one.
      if (pathname === "/chat" && mayNavigate()) {
        setOpened(undefined);
        await navigate({ to: "/chat", search: { workspace, thread: conversation.threadId } });
      }
    } catch (error) {
      conversations.current.delete(workspace);
      setErrors((current) => ({ ...current, [workspace]: error instanceof Error ? error.message : "Could not open Valet." }));
    }
  }
  const conversation = loaded[workspace];
  const visible = opened === workspace && pathname !== "/chat" && !/^\/workflows\/[^/]+$/.test(pathname);
  const panel = visible ? <aside aria-label="Valet assistant" className="absolute inset-0 z-40 flex min-h-0 flex-col border-l border-line bg-paper lg:static lg:w-[440px] lg:shrink-0">
      <div className="flex h-[60px] shrink-0 items-center gap-2 border-b border-line px-4">
        <Sparkles className="h-4 w-4" /><span className="min-w-0 flex-1 text-sm font-medium">Valet · {scope.teamId ? "Team workspace" : "Personal"}</span>
        {conversation && <button aria-label="Open assistant in Threads" className="rounded p-2 hover:bg-ink-wash" onClick={() => { close(); void navigate({ to: "/chat", search: { workspace, thread: conversation.threadId } }); }}><ExternalLink className="h-4 w-4" /></button>}
        <button aria-label="Close Valet" className="rounded p-2 hover:bg-ink-wash" onClick={close}><X className="h-4 w-4" /></button>
      </div>
      {errors[workspace] ? <div role="alert" className="p-4 text-sm">{errors[workspace]}<Button onClick={() => void open()}>Retry</Button></div> : conversation ? <SessionView key={`${workspace}:${conversation.threadId}`} panel hidePanelHeader scopeNotice={scope.teamId ? "Shared with your team. Members can read and reply." : undefined} sessionId={conversation.sessionId} activeThreadId={conversation.threadId} /> : <p className="p-4 text-sm text-muted">Opening your workspace thread…</p>}
    </aside> : null;
  return <Context.Provider value={{ open: (prompt) => { void open(prompt); }, panel, close, isOpen: visible }}>{children}</Context.Provider>;
}

export function WorkspaceAssistantButton() {
  const assistant = useWorkspaceAssistant();
  return <Button size="sm" variant="ghost" onClick={() => assistant.open()}><Sparkles className="h-4 w-4" /><span className="hidden sm:inline">Ask Valet</span></Button>;
}

export function WorkspaceAssistantDock() { return useWorkspaceAssistant().panel; }
