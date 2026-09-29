import { useWorkspaceAssistant } from "~/components/layout/workspace-assistant";
import type {
  EventSubscriptionTargetWire,
  EventSubscriptionWire
} from "@valet/api/wire";
import { MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import {
  useDeleteEventSubscription,
  useEventSubscriptions,
  usePatchEventSubscription,
} from "~/api/events";
import { useMe, useOrg, useTeams } from "~/api/settings";
import { useWorkflows } from "~/api/workflows";
import { OwnerBadge } from "~/components/owner-badge";
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyRow,
  ErrorRow,
  LoadingRow,
  Switch,
  Tooltip,
} from "~/components/primitives";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { errorText } from "~/lib/error-text";
import { selectsSlackMention } from "~/lib/slack-mention";
import { useListOwner } from "~/lib/use-list-owner";
import { AutomationWizard } from "./automation-wizard";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";

/** Mirrors the server's `canMutateSubscription`: an org-owned subscription
 * is everyone's to manage, a team's belongs to its members, and a personal
 * one to its owner. */
export function canMutate(
  sub: EventSubscriptionWire,
  userId: string | undefined,
  memberTeamIds: ReadonlySet<string>,
): boolean {
  if (sub.ownerType === "org") return true;
  if (sub.ownerType === "team") return memberTeamIds.has(sub.ownerId);
  return sub.ownerId === userId;
}

/**
 * The channel scope of a `slack.app_mention` subscription, or null for any
 * other subscription. A mention rule with no channel filter IS the explicit
 * any-channel state (the server refuses the unscoped default, TKAI-299), so
 * the row must say which one the reader is looking at.
 */
export function mentionChannelScope(sub: EventSubscriptionWire): string | null {
  if (!selectsSlackMention(sub.eventKeys)) return null;
  const names: string[] = [];
  for (const f of sub.filters) {
    if (f.field !== "channel" || (f.op !== "eq" && f.op !== "in")) continue;
    if (Array.isArray(f.value)) {
      // Prefer the aligned display labels; fall back to raw ids per entry.
      names.push(...f.value.map((v, i) => f.labels?.[i] ?? v));
    } else {
      names.push(f.label ?? f.value);
    }
  }
  if (names.length === 0) return "any channel";
  if (names.length === 1) return `only ${names[0]}`;
  if (names.length === 2) return `only ${names[0]} and ${names[1]}`;
  return `${names.length} channels`;
}

/**
 * Who may invoke a team assistant by mention, for a team mention rule; null
 * for every other row. The rule reads the same either way from the outside,
 * so the row has to say which audience it carries. An absent audience is the
 * team, which is what every rule written before the choice existed means.
 */
export function mentionAudienceLabel(sub: EventSubscriptionWire): string | null {
  const teamAssistant =
    sub.ownerType === "team" && sub.target.kind === "orchestrator" && sub.target.orchestrator === "team";
  if (!teamAssistant || !selectsSlackMention(sub.eventKeys)) return null;
  return sub.audience === "organization" ? "org members" : "team only";
}

function describeTarget(
  target: EventSubscriptionTargetWire,
  workflowNames: Map<string, string>,
  teamNames: Map<string, string>,
): string {
  if (target.kind === "workflow") {
    return `Run workflow: ${workflowNames.get(target.workflowId) ?? target.workflowId}`;
  }
  if (target.orchestrator === "org") return "Notify the org assistant";
  if (target.orchestrator === "team") {
    const name = target.teamId !== undefined ? teamNames.get(target.teamId) : undefined;
    return name !== undefined ? `Notify ${name}'s assistant` : "Notify the team's assistant";
  }
  return "Notify your assistant";
}

/**
 * Event subscriptions: the rules that turn an ingested event into action —
 * a workflow run or an orchestrator prompt. List with enable/disable,
 * edit (`EditSubscriptionDialog`), and delete; create via
 * `AutomationWizard`.
 *
 * The list is the active workspace's, plus every org-owned subscription. An
 * org-owned row belongs to no single workspace, so the route returns it in
 * all of them — otherwise the create dialog's "Notify the org assistant"
 * option writes a row this page can never disable.
 */
export function SubscriptionsPanel() {
  const assistant = useWorkspaceAssistant();
  const owner = useListOwner();
  const meQ = useMe();
  // `useListOwner` also answers undefined when identity FAILS, and that
  // hold never ends. Report it instead.
  const ownerFailed = owner === undefined && meQ.isError;
  // An owner-less request lists every subscription in the org, so hold the
  // query until the owner resolves. Same gate the feed uses.
  const subsQ = useEventSubscriptions(owner, {
    refetchInterval: 5_000,
    enabled: owner !== undefined,
  });
  const workflowsQ = useWorkflows();
  const teamsQ = useTeams();
  const [creating, setCreating] = useState(false);
  const [organizationScope, setOrganizationScope] = useState<string>();
  const scopeKey = owner ? `${owner.ownerType}:${owner.ownerId}` : undefined;
  const showOrganization = scopeKey !== undefined && organizationScope === scopeKey;
  const subscriptions = (subsQ.data?.subscriptions ?? []).filter((sub) => showOrganization
    ? sub.ownerType === "org"
    : sub.ownerType === owner?.ownerType && sub.ownerId === owner?.ownerId);


  const workflowNames = useMemo(
    () => new Map((workflowsQ.data?.workflows ?? []).map((w) => [w.id, w.name])),
    [workflowsQ.data],
  );
  const orgQ = useOrg();
  const teamNames = useMemo(
    () => new Map((teamsQ.data?.teams ?? []).map((t) => [t.id, t.name])),
    [teamsQ.data],
  );
  // Membership, not visibility: an org admin sees every team in the org,
  // but only a member may manage a team's subscriptions. `eligibleTeams` is
  // the one encoding of that rule (callerRole plus the org feature gate).
  const memberTeamIds = useMemo(
    () =>
      new Set(
        eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations).map((t) => t.id),
      ),
    [teamsQ.data, orgQ.data],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          A subscription runs a workflow or prompts an orchestrator when a matching event arrives.
        </p>
        <div className="flex items-center gap-2"><Button size="sm" onClick={() => assistant.open("Help me configure an event subscription in this workspace. Ask which event should trigger it, what should happen, and where replies should go. Explain the proposed configuration before changing it.")}>Create with Valet</Button>
        <Button variant="ghost" type="button" size="sm" className="shrink-0 gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Manual setup
        </Button></div>
      </div>

      <label className="flex items-center gap-2 text-sm text-muted">Show
        <select aria-label="Subscription scope" value={showOrganization ? "organization" : "workspace"} onChange={(event) => setOrganizationScope(event.target.value === "organization" ? scopeKey : undefined)} className="rounded border border-line bg-paper px-3 py-2 text-ink">
          <option value="workspace">This workspace</option>
          <option value="organization">Organization rules</option>
        </select>
      </label>
      {showOrganization && <p className="text-xs text-muted">These rules belong to the organization. Creation above uses the selected workspace.</p>}
      {/* `isPending`, not `isLoading`: a held query still counts as
          loading. */}
      {subsQ.isPending && !ownerFailed && <LoadingRow label="Loading subscriptions…" />}
      {subsQ.error != null && <ErrorRow>Failed to load subscriptions.</ErrorRow>}
      {ownerFailed && (
        <ErrorRow>
          Could not load your workspace, so subscriptions cannot be listed for it. Reload the page
          to try again.
        </ErrorRow>
      )}

      {subsQ.data && subscriptions.length === 0 && (
        <EmptyRow>No subscriptions yet. Create one above.</EmptyRow>
      )}

      {subsQ.data && subscriptions.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {subscriptions.map((sub) => (
            <SubscriptionRow
              key={sub.id}
              sub={sub}
              workflowNames={workflowNames}
              teamNames={teamNames}
              viewerId={meQ.data?.id}
              mutable={canMutate(sub, meQ.data?.id, memberTeamIds)}
            />
          ))}
        </div>
      )}

      {/* Mounted only while open: the wizard computes its default target at
          mount, so mount time must be open time (see its header comment).
          Also keeps its catalog/workflow queries off the tab's initial
          load. */}
      {creating && <AutomationWizard open onOpenChange={setCreating} />}
    </div>
  );
}

function SubscriptionRow({
  sub,
  workflowNames,
  teamNames,
  viewerId,
  mutable,
}: {
  sub: EventSubscriptionWire;
  workflowNames: Map<string, string>;
  teamNames: Map<string, string>;
  /** The caller's user id; undefined while `useMe` loads. */
  viewerId: string | undefined;
  /** False for a colleague's personal subscription — visible, not actionable. */
  mutable: boolean;
}) {
  const patch = usePatchEventSubscription();
  const del = useDeleteEventSubscription();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const channelScope = mentionChannelScope(sub);
  const audienceScope = mentionAudienceLabel(sub);

  return (
    <div className="flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap">
      <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="break-words text-sm font-medium text-ink">{sub.name}</span>
          {/* Show the workspace owner, independent of its runtime identity. */}
          {sub.ownerType === "org" && (
            <Badge variant="accent" className="shrink-0">
              Org
            </Badge>
          )}
          <OwnerBadge
            ownerType={sub.ownerType}
            ownerId={sub.ownerId}
          />
          {sub.ownerType === "user" && viewerId !== undefined && sub.ownerId !== viewerId && (
            <Tooltip content="A colleague's personal subscription. Only they can change it.">
              <Badge variant="neutral" className="shrink-0">
                Personal
              </Badge>
            </Tooltip>
          )}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {sub.eventKeys.map((k) => (
            <span key={k} className="break-all font-mono text-xs text-muted">
              {k}
            </span>
          ))}
          <span className="text-xs text-muted">
            → {describeTarget(sub.target, workflowNames, teamNames)}
            {!sub.enabled && sub.target.kind === "orchestrator" && sub.target.overlapPausedAt && <span role="status" className="mt-2 block text-warning-600">Paused because a team subscription matched an event. Review delivery preferences, then turn this subscription back on.</span>}
          </span>
          {channelScope && <span className="text-xs text-muted">· {channelScope}</span>}
          {audienceScope && <span className="text-xs text-muted">· {audienceScope}</span>}
          {sub.filters.length > 0 && (
            <span className="text-xs text-muted">
              · {sub.filters.length} filter{sub.filters.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {toggleError && <p className="mt-1 text-xs text-danger-500">{toggleError}</p>}
      </div>

      <Switch
        checked={sub.enabled}
        disabled={patch.isPending || !mutable}
        aria-label={sub.enabled ? `Disable ${sub.name}` : `Enable ${sub.name}`}
        onCheckedChange={(enabled) => {
          setToggleError(null);
          patch.mutate(
            { id: sub.id, body: { enabled } },
            { onError: (err) => setToggleError(errorText(err)) },
          );
        }}
      />

      {mutable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" aria-label={`${sub.name} actions`}>
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              Edit subscription
            </DropdownMenuItem>
            <DropdownMenuItem className="text-danger-500" onSelect={() => setConfirmDelete(true)}>
              Delete subscription
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Mounted only while open: the form seeds from `sub` at mount (see the
          dialog's header comment). */}
      {editing && (
        <EditSubscriptionDialog
          open
          onOpenChange={setEditing}
          sub={sub}
          targetLabel={describeTarget(sub.target, workflowNames, teamNames)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${sub.name}?`}
        description="Matching events will no longer run this target. Past events and deliveries are kept."
        confirmLabel="Delete subscription"
        pendingLabel="Deleting…"
        pending={del.isPending}
        error={del.error != null ? errorText(del.error) : undefined}
        onConfirm={() => del.mutate(sub.id, { onSuccess: () => setConfirmDelete(false) })}
      />
    </div>
  );
}
