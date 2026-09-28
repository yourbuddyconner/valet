import type { Principal } from "@valet/engine";
import { Hono } from "hono";
import { canViewAssistantOwner } from "../assistants/access.js";
import {
  listAssistantsForOwners,
  toAssistantSummary,
} from "../assistants/service.js";
import type { AppEnv } from "../env.js";
import { listTeamsForUser } from "../services/teams.js";
import type { ListAssistantsResponse } from "../wire/types.js";
import { readOwnerFilter } from "./_owner-filter.js";

export const assistantsRouter = new Hono<AppEnv>();

// ── List ──────────────────────────────────────────────────────────────────

/**
 * Without a filter this returns every assistant the caller can reach: their
 * own, plus one entry per team they belong to. Org-owned assistants are not
 * included — `canViewSession` admits nobody to an org-owned session, and
 * this route does not invent a rule that check does not have.
 */
assistantsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const filter = readOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);

  if (filter.owner) {
    if (!(await canViewAssistantOwner(db, filter.owner, c.var.principal))) {
      return c.json({ error: "owner not found" }, 404);
    }
    const rows = await listAssistantsForOwners(db, user.orgId, [filter.owner]);
    const body: ListAssistantsResponse = { assistants: rows.map(toAssistantSummary) };
    return c.json(body);
  }

  const teams = await listTeamsForUser(db, user.id);
  const owners: Principal[] = [
    { type: "user", id: user.id },
    ...teams.filter((t) => t.orgId === user.orgId).map((t): Principal => ({ type: "team", id: t.id })),
  ];
  const rows = await listAssistantsForOwners(db, user.orgId, owners);
  const body: ListAssistantsResponse = { assistants: rows.map(toAssistantSummary) };
  return c.json(body);
});
