import type { GatePromptRef } from "@valet/engine";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";

/** Reuse the engine's durable gate references for transport callback addresses. */
export async function savedGatePrompts(db: AppDb, orgId: string) {
  const rows = await db.select({
    gateId: sql<string>`r.gate_id`, sessionId: sql<string>`g.session_id`, ref: sql<string>`r.ref`,
  }).from(sql`engine_decision_gate_refs r`)
    .innerJoin(sql`engine_decision_gates g`, sql`g.id = r.gate_id`)
    .innerJoin(sql`engine_sessions s`, sql`s.id = g.session_id`)
    .where(eq(sql`s.org_id`, orgId));
  const prompts: Array<{ gateId: string; sessionId: string; ref: GatePromptRef }> = [];
  for (const row of rows) {
    let ref: unknown;
    try { ref = JSON.parse(row.ref); } catch { continue; }
    if (typeof ref !== "object" || ref === null || !("channelId" in ref) || !("messageId" in ref)
      || typeof ref.channelId !== "string" || typeof ref.messageId !== "string") continue;
    prompts.push({ gateId: row.gateId, sessionId: row.sessionId,
      ref: { conversationKey: ref.channelId, messageId: ref.messageId } });
  }
  return prompts;
}

export async function deleteSavedGatePrompts(db: AppDb, gateId: string): Promise<void> {
  await db.execute(sql`DELETE FROM engine_decision_gate_refs WHERE gate_id = ${gateId}`);
}
