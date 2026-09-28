import { useSearch } from "@tanstack/react-router";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";

const STORAGE_KEY = "valet:workspace";

/** Your own workspace. Not a team id, and never a user id — the key is a
 * routing value, not a principal. `useWorkspaceScope().teamId` is what
 * addresses a resource. */
export const PERSONAL = "user";

function loadStored(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? PERSONAL;
  } catch {
    return PERSONAL;
  }
}

export interface WorkspaceScope {
  /** `"user"` for your own workspace, else a team id. */
  key: string;
  /**
   * The team id when scoped to a team, `undefined` when personal.
   *
   * This is the shape the create routes already take (`teamId?: string`,
   * absent meaning you), so a form passes it straight through instead of
   * asking the user a question the nav has answered.
   */
  teamId: string | undefined;
  /** The keys the caller may actually switch to, own workspace first. */
  available: string[];
  setKey(next: string): void;
}

const WorkspaceScopeContext = createContext<WorkspaceScope | null>(null);

/**
 * Which workspace is active, given what is currently known.
 *
 * Pure, and exported, because the interesting case is a race and a race is
 * not worth a render harness to reproduce. The open assistant wins when
 * there is one. Otherwise the stored key stands, and it is only discarded
 * once membership is actually KNOWN — while either query is still loading,
 * `available` holds the caller's own workspace alone, and reading that as
 * proof the team is gone drops a valid scope, which the caller then
 * persists.
 */
export function resolveWorkspaceKey(args: {
  /** The open assistant's workspace, when a conversation is open. */
  derived: string | undefined;
  stored: string;
  /** Every workspace the caller may switch to, own workspace first. */
  available: readonly string[];
  /** False while either the teams or the org query is still loading. */
  membershipKnown: boolean;
}): string {
  if (args.derived !== undefined) return args.derived;
  if (!args.membershipKnown) return args.stored;
  return args.available.includes(args.stored) ? args.stored : PERSONAL;
}

export function WorkspaceScopeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<string>(() => loadStored());

  const setKey = useCallback((next: string) => {
    setStored(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-persistent environments still get the in-session behaviour.
    }
  }, []);

  // `strict: false` because this provider sits above the route tree and must
  // read the same search param from any route, including those that declare
  // none.
  const search = (useSearch({ strict: false }) ?? {}) as { workspace?: string };
  const teamsQ = useTeams();
  const orgQ = useOrg();

  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const available = useMemo(() => [PERSONAL, ...teams.map((t) => t.id)], [teams]);

  const derived = search.workspace;

  // Both queries, not either: `available` is derived from the two together.
  const membershipKnown = teamsQ.data !== undefined && orgQ.data !== undefined;
  const key = resolveWorkspaceKey({ derived, stored, available, membershipKnown });

  // Persist the explicit workspace, so leaving `/chat` keeps the
  // workspace you were last actually in.
  useEffect(() => {
    if (key !== stored) setKey(key);
  }, [key, stored, setKey]);

  const value = useMemo<WorkspaceScope>(
    () => ({
      key,
      teamId: key === PERSONAL ? undefined : key,
      available,
      setKey,
    }),
    [key, available, setKey],
  );

  return <WorkspaceScopeContext.Provider value={value}>{children}</WorkspaceScopeContext.Provider>;
}

/**
 * The active workspace, falling back to your own outside the provider.
 *
 * The fallback is safe in the direction that matters. Personal scope can
 * only ever UNDER-scope — it shows your own rows, and a missed team scope
 * reads as an empty list, which is visible. It cannot over-scope, because
 * no default names a team, so no component can be tricked into rendering
 * one workspace's data under another workspace's name.
 *
 * An earlier version threw here. That is stricter than the risk warrants and
 * pushes a router and a query client into every unit test of every component
 * that happens to read the scope, for a failure mode the default cannot
 * produce.
 */
const PERSONAL_SCOPE: WorkspaceScope = {
  key: PERSONAL,
  teamId: undefined,
  available: [PERSONAL],
  setKey: () => {},
};

export function useWorkspaceScope(): WorkspaceScope {
  return useContext(WorkspaceScopeContext) ?? PERSONAL_SCOPE;
}

/**
 * Adopt a resource's workspace when you land on its page — from a
 * notification, a shared link, or a bookmark. The switcher then matches what
 * is on screen instead of leaving you in the workspace you came from, which
 * is the friction a team-owned session or workflow-run deep link caused: you
 * arrived with the nav still on Personal while the page belonged to a team.
 *
 * This is the same "the thing you have open decides the workspace" rule the
 * scope provider already applies to the workspace URL on `/chat`, extended
 * to detail pages that carry no `?workspace=`. A user-owned resource adopts
 * your personal workspace for the same reason.
 *
 * Keyed on the owner, so a manual switch made afterward on the same page is
 * NOT overridden — the effect only re-fires when you open a different
 * resource. `owner` is `undefined` while the page's data loads; adoption
 * waits for it.
 */
export function useAdoptWorkspaceScope(owner: { type: string; id: string } | undefined): void {
  const { setKey } = useWorkspaceScope();
  const key = workspaceKeyForOwner(owner);
  useEffect(() => {
    if (key !== undefined) setKey(key);
  }, [key, setKey]);
}

/**
 * The switcher key a resource's owner maps to: a team id for a team-owned
 * resource, else your personal workspace. `undefined` while the owner is
 * unknown (data still loading), which suppresses adoption. Pure, so the
 * mapping is tested without a provider.
 */
export function workspaceKeyForOwner(owner: { type: string; id: string } | undefined): string | undefined {
  if (!owner) return undefined;
  return owner.type === "team" ? owner.id : PERSONAL;
}
