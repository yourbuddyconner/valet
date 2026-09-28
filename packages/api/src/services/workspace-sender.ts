import type { Principal } from "@valet/engine";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { orgs, teams } from "../schema/index.js";

/** Personal posts use the bot identity; shared posts use the workspace name. */
export async function workspaceSenderIdentity(db: AppDb, orgId: string, owner: Principal): Promise<{ displayName: string } | undefined> {
  if (owner.type === "user") return undefined;
  try {
    const [row] = owner.type === "team"
      ? await db.select({ name: teams.name }).from(teams).where(and(eq(teams.id, owner.id), eq(teams.orgId, orgId))).limit(1)
      : await db.select({ name: orgs.name }).from(orgs).where(and(eq(orgs.id, owner.id), eq(orgs.id, orgId))).limit(1);
    return row?.name ? { displayName: row.name } : undefined;
  } catch (error) {
    // Display identity is optional; a lookup failure must not lose the message.
    console.error("[workspace-sender] Cannot read the workspace name; using the bot identity.", error);
    return undefined;
  }
}
