import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
  Principal,
} from "@valet/engine";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import type { AppDb } from "../lib/drizzle.js";
import { listTeamsForUser } from "../services/teams.js";
import { listAssistantsForOwners, toAssistantSummary } from "./service.js";

/** Curried action builder — same shape as `skills-actions.ts`. */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

const NO_OWNER: PluginActionResult = {
  success: false,
  error: "no authenticated principal in tool context",
};

function callerFromContext(ctx: PluginActionContext): { userId: string; orgId: string } | null {
  const { userId, orgId } = ctx as { userId?: unknown; orgId?: unknown };
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof orgId !== "string" || orgId.length === 0) return null;
  return { userId, orgId };
}



export function assistantsActionPlugin(db: AppDb, _evict: (sessionId: string) => void): ActionPlugin {
  const listAction = action(Type.Object({}))({
    id: "assistants.list_assistants",
    name: "List assistants",
    description:
      "List the assistants you can reach: your own, plus one set per team you belong to. " +
      "Returns each assistant's id, name, owner, default flag, personality, and behavior config. " +
      "A team's seeded default is unnamed: its name is absent until someone names it. " +
      "Refer to such a row by id, or by its owner and default flag.",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const caller = callerFromContext(ctx);
      if (!caller) return NO_OWNER;
      const teams = await listTeamsForUser(db, caller.userId);
      const owners: Principal[] = [
        { type: "user", id: caller.userId },
        ...teams
          .filter((t) => t.orgId === caller.orgId)
          .map((t): Principal => ({ type: "team", id: t.id })),
      ];
      const rows = await listAssistantsForOwners(db, caller.orgId, owners);
      return { success: true, data: { assistants: rows.map(toAssistantSummary) } };
    },
  });

  return {
    service: "assistants",
    description: "Read workspace conversation identities for compatibility.",
    actions: [listAction],
  };
}
