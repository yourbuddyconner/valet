import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { pgDbFromPglite } from "../src/db.js";
import { applyEngineMigrations } from "../src/migrate.js";
import { PgSessionStore } from "../src/store.js";

it("keeps gate prompt references with equal message IDs in different conversations", async () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  try {
    await applyEngineMigrations(db);
    const store = new PgSessionStore(db);
    for (const channelId of ["slack:T1:DM_A", "slack:T1:DM_B"]) {
      await store.saveDecisionGateRef("session", "thread", "gate", {
        channelType: "slack", ref: { channelId, messageId: "100.1" },
      });
    }
    expect((await db.query("SELECT * FROM engine_decision_gate_refs")).rows).toHaveLength(2);
  } finally {
    await pglite.close();
  }
});
