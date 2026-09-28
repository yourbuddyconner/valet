import type { Principal } from "@valet/engine";
import { Hono } from "hono";
import { assistantOwner, canAdministerAssistantOwner, canViewAssistantOwner } from "../assistants/access.js";
import {
  ensureAssistantSession, listAssistantsForOwners, loadAssistant,
  resolveDefaultAssistant, toAssistantSummary, WORKSPACE_ASSISTANT_MESSAGE,
} from "../assistants/service.js";
import type { AppEnv } from "../env.js";
import { listTeamsForUser } from "../services/teams.js";
import type { EnsureAssistantSessionResponse, ListAssistantsResponse } from "../wire/types.js";
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

// Compatibility initialization: the workspace owns exactly one active assistant.
assistantsRouter.post("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected an object" }, 400);
  let owner: Principal = { type: "user", id: user.id };
  if ("owner" in body && body.owner !== undefined) {
    const value = body.owner;
    if (!value || typeof value !== "object" || !("type" in value) || !("id" in value) ||
        (value.type !== "user" && value.type !== "team") || typeof value.id !== "string" || !value.id) {
      return c.json({ error: "owner must identify a personal or team workspace" }, 400);
    }
    owner = { type: value.type, id: value.id };
  }
  if (!(await canAdministerAssistantOwner(db, owner, c.var.principal))) return c.json({ error: "owner not found" }, 404);
  if (Object.keys(body).some(key => key !== "owner")) return c.json({ error: WORKSPACE_ASSISTANT_MESSAGE }, 409);
  const row = await resolveDefaultAssistant(db, user.orgId, owner);
  return c.json(toAssistantSummary(row), 200);
});

// Old editing links and clients cannot recreate assistant customization.
assistantsRouter.on(["PATCH", "DELETE"], "/:id", async (c) => {
  const row = await loadAssistant(c.var.providers.db, c.req.param("id"));
  if (!row || row.orgId !== c.var.user.orgId ||
      !(await canAdministerAssistantOwner(c.var.providers.db, assistantOwner(row), c.var.principal))) {
    return c.json({ error: "assistant not found" }, 404);
  }
  return c.json({ error: WORKSPACE_ASSISTANT_MESSAGE }, 409);
});

// ── Open (get-or-create the session) ──────────────────────────────────────

/**
 * `POST /api/assistants/:id/session` — get-or-create this assistant's
 * session, and return its id.
 *
 * Creating an assistant writes only the `assistants` row, so a new one has
 * no session until somebody opens it. Every ordinary session route reads the
 * `agent_sessions` app row, so without this call a freshly created assistant
 * lists correctly and then 404s on the first click.
 *
 * Idempotent, and safe to call on every mount — it is the same get-or-create
 * `POST /api/orchestrator` performs for a principal's default, addressed by
 * assistant instead. Reading is enough to earn it: anyone who may view the
 * assistant may open the conversation.
 */
assistantsRouter.post("/:id/session", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;

  const row = await loadAssistant(db, c.req.param("id"));
  if (!row || row.orgId !== user.orgId) return c.json({ error: "assistant not found" }, 404);
  if (!(await canViewAssistantOwner(db, assistantOwner(row), c.var.principal))) {
    return c.json({ error: "assistant not found" }, 404);
  }
  if (row.archivedAt !== null) {
    // The same wording as ArchivedAssistantError: no restore path exists,
    // so the corrective action a user CAN take is creating a new assistant.
    return c.json(
      { error: "This assistant is archived. Create a new assistant instead." },
      409,
    );
  }

  const { sessionId } = await ensureAssistantSession({ db, engineHost }, row, {
    actorUserId: user.id,
    orgId: user.orgId,
  });
  const body: EnsureAssistantSessionResponse = { sessionId };
  return c.json(body);
});
