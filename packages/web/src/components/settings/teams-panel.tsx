import { Link } from "@tanstack/react-router";
import type { OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";
import { Bot, ChevronRight, MoreHorizontal, UserPlus, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "~/api/client";
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useMe,
  useModels,
  usePatchTeam,
  useRemoveTeamMember,
  useSetTeamMemberRole,
  useTeamMembers,
  useTeams,
} from "~/api/settings";
import { TeamCredentials } from "~/components/integrations/team-credentials";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyRow,
  ErrorRow,
  Input,
  LoadingRow,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/primitives";
import { ModelCombobox } from "~/components/settings/model-combobox";
import { ReasoningSelect } from "~/components/settings/reasoning-select";
import { errorText } from "~/lib/error-text";
import { formatDate } from "~/lib/format-when";
import { isSizeTier, TIER_LABELS } from "~/lib/model-tiers";
import { curatedForCatalogId } from "~/lib/models";
import { reasoningLabelFor } from "~/lib/reasoning";
import { matchesNeedle } from "~/lib/text-match";
import { TeamDeletionRequests } from "./team-deletion-requests";
import { TeamOnePasswordToken } from "./team-onepassword-token";

/**
 * Says what a declared team's controls do and do not survive.
 *
 * The member controls stay live here, unlike a mirrored team's, because the
 * config file only adds. The reader still needs the half that does not last:
 * a person removed here comes back at the next restart if the file still
 * declares them.
 */
const CONFIG_MANAGED_NOTE =
  "This team is declared in valet.yaml. You can change its members here, but a restart adds the " +
  "declared members back. Edit the file to change that list, or to delete the team.";

/** What a delete removes, for every team. */
const DELETE_TEAM_NOTE =
  "This deletes the team, its membership, its skills and skill sources, and its workflows. " +
  "If a team workflow is still running, the delete fails — wait for it to finish, or cancel it, then try again. " +
  "Org members themselves are not affected.";

/**
 * Organization · Teams — the first-ever teams management UI over the
 * existing `/api/teams` router. List with inline create, per-team expand
 * revealing the member roster + add/remove/role-toggle, and delete-via-
 * confirm. All member display data (name/email/avatar) is cross-referenced
 * against the org directory (`useOrgDirectory()`, member-visible) since
 * `TeamMemberSummary` on the wire is only `{userId, role}`.
 *
 * A team with `origin === "idp"` keeps its provenance badge, but its
 * membership is managed here. Login only refreshes join eligibility and
 * never changes a team or membership.
 *
 * A team with `origin === "config"` is declared in `valet.yaml`, and it is
 * deliberately treated differently. The file only asserts members, so the
 * member controls keep working and the panel keeps them. Only delete goes,
 * because the API refuses it: the next boot would recreate the team empty.
 * `CONFIG_MANAGED_NOTE` states the half a reader cannot see — that a restart
 * puts the declared members back.
 */
export function TeamsPanel({
  orgMembers,
  teamId,
  showAssistantLink = false,
}: {
  orgMembers: OrgDirectoryUserWire[];
  /** Pin the panel to the selected workspace, without team creation. */
  teamId?: string;
  /** Show the assistant link only when this panel has the active team scope. */
  showAssistantLink?: boolean;
}) {
  const teamsQ = useTeams();
  const meQ = useMe();
  const [expanded, setExpanded] = useState<string | null>(teamId ?? null);
  // Mirrors the API's canMutateTeam gate: team admin of that team, or org
  // admin. The API still enforces; this only hides controls that would 404.
  const orgAdmin = meQ.data?.orgRole === "admin";
  const teams = teamsQ.data?.teams.filter((team) => teamId === undefined || team.id === teamId) ?? [];
  const ready = !teamsQ.isLoading && teamsQ.error == null;

  return (
    <div className="space-y-4">
      {teamId === undefined && <CreateTeamRow />}

      {teamsQ.isLoading && <LoadingRow />}
      {teamsQ.error != null && <ErrorRow>Failed to load teams. Reload the page to try again.</ErrorRow>}

      {ready && teamsQ.data && teams.length === 0 && (
        <EmptyRow>
          {teamId === undefined
            ? "No teams yet. Create one above."
            : "This team is unavailable. Select another workspace or reload the page."}
        </EmptyRow>
      )}

      {ready && teamsQ.data && teams.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {teams.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              orgMembers={orgMembers}
              canMutate={orgAdmin || team.callerRole === "admin"}
              showAssistantLink={showAssistantLink}
              open={expanded === team.id}
              onToggle={() => setExpanded((cur) => (cur === team.id ? null : team.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTeamRow() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createTeam = useCreateTeam();

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    createTeam.mutate(
      { name: trimmed },
      {
        onSuccess: () => setName(""),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            setError("A team with that name already exists.");
          } else {
            setError(errorText(err));
          }
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="New team name"
          aria-label="New team name"
          className="flex-1"
        />
        <Button type="button" onClick={submit} disabled={!name.trim() || createTeam.isPending}>
          {createTeam.isPending ? "Creating…" : "Create"}
        </Button>
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
    </div>
  );
}

function TeamRow({
  team,
  orgMembers,
  canMutate,
  showAssistantLink,
  open,
  onToggle,
}: {
  team: TeamSummary;
  orgMembers: OrgDirectoryUserWire[];
  canMutate: boolean;
  showAssistantLink: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTeam = useDeleteTeam();
  const idpBacked = team.origin === "idp";
  const declared = team.origin === "config";

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label={open ? `Collapse ${team.name}` : `Expand ${team.name}`}
          aria-expanded={open}
          className="flex min-h-11 min-w-0 basis-full flex-wrap sm:flex-1 sm:basis-auto items-center gap-2 text-left sm:min-h-0"
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
          <span className="truncate text-sm font-medium text-ink">{team.name}</span>
          {idpBacked && (
            <Badge variant="neutral" className="shrink-0">
              Identity provider
            </Badge>
          )}
          {declared && (
            // `neutral`, not the mirrored team's `accent`: this team's
            // controls still work, so it must not read as equally locked.
            <Badge variant="neutral" className="shrink-0" title={CONFIG_MANAGED_NOTE}>
              Declared in valet.yaml
            </Badge>
          )}
          <span className="shrink-0 text-xs text-muted">
            {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
          </span>
        </button>
        <span className="hidden shrink-0 text-xs text-muted sm:block">
          Created {formatDate(team.createdAt)}
        </span>
        {showAssistantLink && (
          <Button asChild variant="ghost" size="sm" className="shrink-0 gap-1.5">
            <Link to="/chat" search={{ workspace: team.id }}>
              <Bot className="h-3.5 w-3.5" aria-hidden />
              Threads
            </Link>
          </Button>
        )}
        {/* Two gates, both required. `canMutate` is authorization; origin is
            provenance — the API refuses a delete on a mirrored team and on a
            declared one, because the next boot would recreate a declared team
            empty. Delete is the only item here, and an empty menu is worse
            than no menu. */}
        {!declared && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${team.name} actions`}
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-danger-500"
                onSelect={() => {
                  // React Query holds `error` until the next mutate, so
                  // without this the last refusal greets the next open.
                  if (canMutate) {
                    deleteTeam.reset();
                    setConfirmDelete(true);
                  } else if (!open) onToggle();
                }}
              >
                {canMutate ? "Delete team" : "Request deletion"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {open && (
        <div className="ml-6 mt-2 space-y-2 border-l border-line pl-4">
          <TeamDeletionRequests key={`deletion-requests:${team.id}`} teamId={team.id} canManage={canMutate} />
          <TeamDefaults team={team} canMutate={canMutate} />
          <TeamCredentials team={team} orgMembers={orgMembers} canMutate={canMutate} />
          <TeamOnePasswordToken key={team.id} teamId={team.id} teamName={team.name} canMutate={canMutate} />
          <TeamMembers team={team} orgMembers={orgMembers} canMutate={canMutate} />
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${team.name}?`}
        description={DELETE_TEAM_NOTE}
        confirmLabel="Delete team"
        pendingLabel="Deleting…"
        pending={deleteTeam.isPending}
        error={deleteTeam.error != null ? errorText(deleteTeam.error) : undefined}
        onConfirm={() => deleteTeam.mutate(team.id, { onSuccess: () => setConfirmDelete(false) })}
      />
    </div>
  );
}


/**
 * The team default model and reasoning level (TKAI-255; reasoning added
 * Task 15). Member-started sessions in this team's workspace start on
 * these unless that member set a personal default; shared team sessions
 * (assistant, workflow runs, children) skip the personal tier and start on
 * them directly. A session's model/reasoning persists, so the setting only
 * shapes sessions built after the change. Null falls through to the
 * cascade's next tier / org default reasoning. Editable by whoever can mutate
 * the team (team admin or org admin) — same gate as the roster controls,
 * and the API enforces it. NOT origin-gated: a mirrored team's membership
 * belongs to the identity provider, but its defaults are Valet-local state
 * no sync rewrites.
 */
function TeamDefaults({
  team,
  canMutate,
}: {
  team: TeamSummary;
  canMutate: boolean;
}) {
  const patchTeam = usePatchTeam();
  // Same label chain as ModelCombobox (tier label, then curated label, then
  // catalog name, then raw id) so members and admins read the same words
  // for one value.
  const modelsQ = useModels();
  const entry = modelsQ.data?.models.find((m) => m.id === team.defaultModel);
  const readOnlyModelLabel = team.defaultModel
    ? isSizeTier(team.defaultModel)
      ? TIER_LABELS[team.defaultModel]
      : (curatedForCatalogId(team.defaultModel)?.label ?? entry?.name ?? team.defaultModel)
    : "Organization default";
  const readOnlyReasoningLabel = team.defaultReasoning
    ? reasoningLabelFor(team.defaultReasoning)
    : "Organization default";

  return (
    <div>
      <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-3">
        <span className="shrink-0 text-xs font-medium text-muted">Default model</span>
        {canMutate ? (
          <div className="w-full max-w-xs">
            <ModelCombobox
              value={team.defaultModel}
              onSelect={(id) => patchTeam.mutate({ id: team.id, body: { defaultModel: id } })}
              onClear={() => patchTeam.mutate({ id: team.id, body: { defaultModel: null } })}
              emptyLabel="Organization default"
            />
          </div>
        ) : (
          <span className="min-w-0 truncate text-sm text-ink" title={team.defaultModel ?? undefined}>
            {readOnlyModelLabel}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-3">
        <span className="shrink-0 text-xs font-medium text-muted">Default reasoning</span>
        {canMutate ? (
          <div className="w-full max-w-xs">
            <ReasoningSelect
              value={team.defaultReasoning ?? null}
              onChange={(defaultReasoning) =>
                patchTeam.mutate({ id: team.id, body: { defaultReasoning } })
              }
              emptyLabel="Organization default"
            />
          </div>
        ) : (
          <span
            className="min-w-0 truncate text-sm text-ink"
            title={team.defaultReasoning ?? undefined}
          >
            {readOnlyReasoningLabel}
          </span>
        )}
      </div>
      <p className="text-xs text-muted">
        New sessions started in this team's workspace use this model and reasoning level. A
        member's personal default wins for sessions that member starts. Existing sessions keep
        their settings, including the team assistant if anyone has already opened it.
      </p>
      {patchTeam.error != null && (
        <p className="text-xs text-danger-500">{errorText(patchTeam.error)}</p>
      )}
    </div>
  );
}

function TeamMembers({
  team,
  orgMembers,
  canMutate,
}: {
  team: TeamSummary;
  orgMembers: OrgDirectoryUserWire[];
  canMutate: boolean;
}) {
  const teamId = team.id;
  const teamName = team.name;
  const declared = team.origin === "config";
  const membersQ = useTeamMembers(teamId);
  const setRole = useSetTeamMemberRole();
  const removeMember = useRemoveTeamMember();
  const addMember = useAddTeamMember();

  const byId = new Map(orgMembers.map((m) => [m.userId, m]));
  const memberRows = membersQ.data?.members ?? [];
  const memberIds = new Set(memberRows.map((m) => m.userId));
  const addable = orgMembers.filter((m) => !memberIds.has(m.userId));

  return (
    <div className="space-y-2">
      {declared && <p className="pt-1 text-xs text-muted">{CONFIG_MANAGED_NOTE}</p>}

      {membersQ.isLoading && <LoadingRow label="Loading members…" className="py-2 text-xs" />}
      {membersQ.error != null && (
        <ErrorRow className="py-2 text-xs">Failed to load {teamName}'s members.</ErrorRow>
      )}

      {memberRows.map((member) => {
        const identity = byId.get(member.userId);
        return (
          <div key={member.userId} className="flex items-center gap-2 py-1">
            <Avatar size="sm">
              <AvatarFallback>
                {(identity?.name ?? identity?.email ?? member.userId).slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-sm text-ink">
              {identity?.name ?? identity?.email ?? member.userId}
            </span>
            {!canMutate ? (
              <Badge variant={member.role === "admin" ? "accent" : "neutral"}>
                {member.role === "admin" ? "Admin" : "Member"}
              </Badge>
            ) : (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="secondary" size="sm">
                      <Badge variant={member.role === "admin" ? "accent" : "neutral"} className="pointer-events-none">
                        {member.role === "admin" ? "Admin" : "Member"}
                      </Badge>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() =>
                        setRole.mutate({ teamId, userId: member.userId, body: { role: "admin" } })
                      }
                    >
                      Admin
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        setRole.mutate({ teamId, userId: member.userId, body: { role: "member" } })
                      }
                    >
                      Member
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${identity?.name ?? identity?.email ?? member.userId} from ${teamName}`}
                  onClick={() => removeMember.mutate({ teamId, userId: member.userId })}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </>
            )}
          </div>
        );
      })}

      {canMutate && (
        <>
          <AddMemberPicker
            teamName={teamName}
            addable={addable}
            pending={addMember.isPending}
            onAdd={(userId) => addMember.mutate({ teamId, body: { userId, role: "member" } })}
          />
          {addMember.error != null && (
            <ErrorRow className="py-1 text-xs">
              Failed to add the member: {errorText(addMember.error)}
            </ErrorRow>
          )}
        </>
      )}
    </div>
  );
}

/** DOM cap for the picker list. The height cap alone fixes the clipping, not
 * the cost of mounting a row per org member; past this a footer row says to
 * type more. */
const ADD_MEMBER_VISIBLE_LIMIT = 50;

/**
 * "Add member" — a popover typeahead over the addable org members. The
 * previous control was a plain dropdown menu with no filter and no height
 * cap, so on a real org it ran past the bottom of the screen.
 *
 * Keyboard and ARIA mechanics follow `ServiceActionCombobox`: one highlighted
 * row that arrow keys and hover both move, Enter adds it, and
 * `aria-activedescendant` announces it. That combobox and `ModelCombobox`
 * keep their own copies of these mechanics; folding the three into one
 * primitive is deliberately out of scope here — their commit semantics
 * differ (free-text commit, clear-to-default, strict pick).
 *
 * When nobody is addable the trigger stays mounted but inert (`aria-disabled`
 * plus a title that says why). Unmounting it would drop keyboard focus to the
 * body at the exact moment the last member is added, because Radix returns
 * focus to this trigger on close.
 */
function AddMemberPicker({
  teamName,
  addable,
  pending,
  onAdd,
}: {
  teamName: string;
  addable: OrgDirectoryUserWire[];
  pending: boolean;
  onAdd: (userId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const matches = useMemo(() => {
    const filtered = addable.filter((m) => matchesNeedle(query, [m.name, m.email]));
    const needle = query.trim().toLowerCase();
    if (!needle) return filtered;
    // Prefix matches outrank substring matches: typing "dana" must put
    // "Dana A" above "adana@…", or Enter adds the wrong person.
    const rank = (m: OrgDirectoryUserWire) =>
      m.name.toLowerCase().startsWith(needle) || m.email.toLowerCase().startsWith(needle) ? 0 : 1;
    return filtered.sort((a, b) => rank(a) - rank(b));
  }, [addable, query]);

  const visible = matches.slice(0, ADD_MEMBER_VISIBLE_LIMIT);
  const hidden = matches.length - visible.length;
  // Clamp instead of trusting state: a background refetch can shrink the
  // list under a highlight that pointed past its new end.
  const active = Math.min(highlighted, Math.max(visible.length - 1, 0));
  const optionId = (i: number) => `${listboxId}-opt-${i}`;
  const inert = addable.length === 0 || pending;

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active];
    if (el instanceof HTMLElement && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [active, open]);

  function add(userId: string) {
    if (pending) return;
    onAdd(userId);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && inert) return;
        setOpen(next);
        // A reopened picker starts from the full list, not last time's filter.
        if (next) {
          setQuery("");
          setHighlighted(0);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`gap-1.5 ${inert ? "text-muted" : ""}`}
          aria-disabled={inert || undefined}
          title={
            addable.length === 0
              ? `Everyone in the organization is already on ${teamName}.`
              : undefined
          }
        >
          <UserPlus className="h-3.5 w-3.5" aria-hidden />
          Add member
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)] p-0">
        <div className="border-b border-line p-2">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlighted(0);
            }}
            onKeyDown={(e) => {
              // Enter that commits an IME composition is not a selection.
              if (e.nativeEvent.isComposing) return;
              if (visible.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlighted(Math.min(active + 1, visible.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlighted(Math.max(active - 1, 0));
              } else if (e.key === "Enter") {
                const target = visible[active];
                if (target) add(target.userId);
              }
            }}
            placeholder="Search members…"
            aria-label={`Search members to add to ${teamName}`}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={visible.length > 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
          />
        </div>
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={`Members to add to ${teamName}`}
          className="max-h-64 overflow-y-auto py-1"
        >
          {visible.map((m, i) => (
            <button
              key={m.userId}
              id={optionId(i)}
              type="button"
              role="option"
              aria-selected={i === active}
              onClick={() => add(m.userId)}
              onMouseEnter={() => setHighlighted(i)}
              className={`flex min-h-11 w-full flex-col items-start gap-1 px-3 py-1.5 text-left text-sm sm:min-h-0 ${
                i === active ? "bg-ink-wash" : ""
              }`}
            >
              <span className="max-w-full break-words text-ink">{m.name || m.email}</span>
              {m.name ? <span className="max-w-full break-all text-xs text-muted">{m.email}</span> : null}
            </button>
          ))}
          {hidden > 0 && (
            <div className="border-t border-line px-3 py-1.5 text-xs text-muted">
              {hidden} more {hidden === 1 ? "match" : "matches"}. Type more letters to narrow the
              list.
            </div>
          )}
          {visible.length === 0 && (
            <div className="px-3 py-1.5 text-sm text-muted">No matching members.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
