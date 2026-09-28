import { useNavigate } from "@tanstack/react-router";
import type { TeamSummary } from "@valet/api/wire";
import { Check, ChevronsUpDown, User, Users } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * Which workspace you are working in: your own, or one of your teams.
 *
 * It sits beside the logo because it scopes the surfaces below it rather
 * than filtering one list — the same position Slack and Linear give a
 * workspace control, and the position that reads as "everything under here
 * belongs to this".
 *
 * **It has no unread badge, deliberately.** In a switcher the other
 * workspaces are off-screen by construction, so hiding attention behind it
 * would be the one real cost of this shape. Notifications stay global — the
 * bell already polls every workspace and every notification links straight
 * to the conversation that needs you, which switches context on arrival.
 * A badge here would be a second, weaker answer to a question the bell
 * already answers completely.
 *
 * Selecting a workspace SETS THE SCOPE, and navigates only from `/chat`.
 * It used to always navigate to that workspace's default assistant, which
 * made the control unusable from `/skills` or `/workflows`: choosing a team
 * threw you into a conversation instead of re-scoping the page you were
 * reading. Staying put is what Slack, Linear and Notion do — the page you
 * are on reloads under the new workspace.
 *
 * A workspace with no assistant is therefore selectable now. It could not be
 * before, because the only thing selecting it did was open an assistant that
 * did not exist. A team with no assistant still owns skills and workflows.
 */
export interface WorkspaceOption {
  /** `user` for your own, else the team id. Stable across renders. */
  key: string;
  label: string;
  isTeam: boolean;

}

/**
 * The workspaces a caller can switch between, in rail order: yours first,
 * then teams as `GET /api/teams` returned them.
 *
 * A workspace with no assistant is still LISTED rather than hidden. Hiding
 * it would make a team you belong to silently absent from a control whose
 * whole job is to enumerate where you can work — the reader would conclude
 * they had been removed from the team.
 */
export function workspaceOptions(teams: TeamSummary[]): WorkspaceOption[] {
  return [
    { key: "user", label: "Personal", isTeam: false },
    ...teams.map(t => ({ key: t.id, label: t.name, isTeam: true })),
  ];
}

export function WorkspaceSwitcher({
  options,
  activeKey,
  onSelect,
  /** True on `/chat`, where the open conversation must follow the scope. */
  navigateOnSelect,
}: {
  options: WorkspaceOption[];
  activeKey: string;
  onSelect: (key: string) => void;
  navigateOnSelect: boolean;
}) {
  const navigate = useNavigate();

  // One workspace is not a choice. A solo user sees the logo alone, exactly
  // as before teams existed.
  if (options.length < 2 && options.some(o => o.key === activeKey)) return null;

  const active = options.find((o) => o.key === activeKey) ?? { key: activeKey, label: "Unavailable workspace", isTeam: true };
  if (!active) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-w-0 shrink gap-1.5 max-w-[11rem] md:shrink-0"
          aria-label={`Workspace: ${active.label}. Change workspace`}
        >
          {active.isTeam ? (
            <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <User className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <span className="truncate text-sm">{active.label}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.key}
            onSelect={() => {
              onSelect(o.key);
              // From `/chat` the open assistant defines the workspace, so the
              // conversation has to move with it or the two disagree. From
              // anywhere else the page simply re-reads the new scope, and
              // navigating would take the reader somewhere they did not ask
              // to go.
              if (!navigateOnSelect) return;
              void navigate({
                to: "/chat",
                search: { workspace: o.key, thread: undefined, child: undefined },
              });
            }}
          >
            <span className={cn("flex w-full items-center gap-2", o.key === activeKey && "font-medium")}>
              {o.isTeam ? (
                <Users className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              ) : (
                <User className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              )}
              <span className="flex-1 truncate">{o.label}</span>
              {o.key === activeKey && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
